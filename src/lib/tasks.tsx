import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { loadManaged, ManagedPod, store } from "./pods";
import { listProjects, loadProject, Project } from "./projects";
import { parseProgress, Progress, ProgressKind } from "./progress";

export type TaskKind =
  | "init"
  | "caption"
  | "upload"
  | "build"
  | "test_caption";

export interface BuildPart {
  name: string;
  video: string;
  clip: number;
  of: number;
  status: "running" | "done" | "failed";
}

export interface BuildState {
  project: string;
  status: "running" | "zipping" | "done" | "failed";
  total_clips: number;
  done_clips: number;
  videos_total?: number;
  videos_done: number;
  /** clips_total per video_index, заполняется по ds_build:video */
  clips_per_video: Record<number, number>;
  /** clips_done per video_index */
  clip_done_per_video: Record<number, number>;
  parts: BuildPart[];
  zip_path?: string;
  error?: string;
  started_at: number;
}

export interface PodTask {
  kind: TaskKind;
  pod_id?: string;
  pod_name: string;
  project_name?: string;
  state: "running" | "failed";
  label: string;
  /** 0..100, если можем оценить */
  progress?: number;
  /** короткий human-label прогресса для отладки/тултипа */
  progress_label?: string;
  step_index?: number; // 1-based, only init
  step_total?: number;
  step_name?: string;
  /** Лог-буфер для live-парсинга прогресса в UI */
  log_key?: string;
  progress_kind?: ProgressKind;
}

interface TestCaptionResult {
  caption: string;
  clip_filename: string;
  video_b64?: string;
  video_mime?: string;
}

export interface SshProbeCached {
  ok: boolean;
  host: string;
  port: number;
  user: string;
  key_used: string | null;
  error: string | null;
}

export interface TasksApi {
  tasks: PodTask[];
  byPod: Map<string, PodTask[]>;
  sshProbes: Map<string, SshProbeCached>;
  getSshProbe: (pod_id: string) => SshProbeCached | null;
  builds: Map<string, BuildState>;
  refresh: () => void;

  // log subscriptions (по ключу)
  getLog: (key: string) => string;
  subscribeLog: (key: string, cb: (chunk: string) => void) => () => void;

  // активные long-running локальные задачи
  isUploading: (pod_id: string, project: string) => boolean;
  isBuilding: (project: string) => boolean;
  isTesting: (pod_id: string, project: string) => boolean;
  // последний результат теста (для модалки)
  takeTestResult: (
    pod_id: string,
    project: string,
  ) => TestCaptionResult | null;

  // start methods
  startUpload: (args: {
    api_key: string;
    pod_id: string;
    project_name: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  startBuild: (args: {
    project_name: string;
    hash: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  startTestCaption: (args: {
    api_key: string;
    pod_id: string;
    project_name: string;
    provider: string;
    instructions?: string | null;
    audio?: boolean;
    gemini_api_key?: string | null;
  }) => Promise<{ ok: boolean; error?: string }>;
}

const TasksContext = createContext<TasksApi | null>(null);
export const useTasks = (): TasksApi => {
  const v = useContext(TasksContext);
  if (!v) throw new Error("useTasks outside provider");
  return v;
};

/**
 * Live-парсинг прогресса из лог-буфера задачи. Возвращает свежий Progress
 * на каждое появление строки в логе (а не раз в 5с с тика).
 */
export function useLiveProgress(
  log_key: string | undefined,
  kind: ProgressKind | undefined,
  fallback?: Progress | null,
): Progress | null {
  const tasks = useContext(TasksContext);
  const [p, setP] = useState<Progress | null>(fallback ?? null);
  useEffect(() => {
    if (!tasks || !log_key || !kind) {
      setP(fallback ?? null);
      return;
    }
    const recompute = () => {
      const pp = parseProgress(kind, tasks.getLog(log_key));
      setP(pp);
    };
    recompute();
    const unsub = tasks.subscribeLog(log_key, () => recompute());
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log_key, kind]);
  return p;
}

const INIT_STEPS = ["packages", "env", "model", "encoder", "verify"] as const;
const POLL_INTERVAL_MS = 5_000;
const LOG_CAP = 200_000;

interface InitState {
  tmux_available: boolean;
  steps: Record<
    string,
    { state: "pending" | "running" | "done" | "failed"; log_size: number }
  >;
}
interface CaptionState {
  state: "pending" | "running" | "done" | "failed";
  log_size: number;
}

// keys:
//   build:<project>
//   upload:<pod_id>:<project>
//   test_caption:<pod_id>:<project>
//   init:<pod_id>:<step>
//   caption:<pod_id>:<project>

export function uploadKey(pod_id: string, project: string) {
  return `upload:${pod_id}:${project}`;
}
export function buildKey(project: string) {
  return `build:${project}`;
}
export function testCaptionKey(pod_id: string, project: string) {
  return `test_caption:${pod_id}:${project}`;
}
export function initStepKey(pod_id: string, step: string) {
  return `init:${pod_id}:${step}`;
}
export function captionKey(pod_id: string, project: string) {
  return `caption:${pod_id}:${project}`;
}

export function TasksProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<PodTask[]>([]);
  const [byPod, setByPod] = useState<Map<string, PodTask[]>>(new Map());
  const [sshProbes, setSshProbes] = useState<Map<string, SshProbeCached>>(
    new Map(),
  );
  const sshProbesRef = useRef<Map<string, SshProbeCached>>(new Map());

  const [builds, setBuilds] = useState<Map<string, BuildState>>(new Map());
  const buildsRef = useRef<Map<string, BuildState>>(new Map());
  const updateBuild = useCallback(
    (projectRaw: string | undefined, mut: (b: BuildState) => BuildState) => {
      // Если бэкенд по какой-то причине не дал project в payload —
      // прилепляем событие к единственному текущему билду.
      let project = projectRaw;
      if (!project) {
        for (const [name, b] of buildsRef.current) {
          if (b.status === "running" || b.status === "zipping") {
            project = name;
            break;
          }
        }
      }
      if (!project) return;
      const cur = buildsRef.current.get(project) ?? {
        project,
        status: "running" as const,
        total_clips: 0,
        done_clips: 0,
        videos_done: 0,
        clips_per_video: {},
        clip_done_per_video: {},
        parts: [],
        started_at: Date.now(),
      };
      const next = mut(cur);
      buildsRef.current.set(project, next);
      setBuilds(new Map(buildsRef.current));
    },
    [],
  );
  const prevKeysRef = useRef<Map<string, PodTask>>(new Map());
  const ticking = useRef(false);

  // log buffers and subscribers, hold in refs so they survive re-renders
  const logsRef = useRef<Map<string, string>>(new Map());
  const subsRef = useRef<Map<string, Set<(s: string) => void>>>(new Map());

  // local long-running task tracking (uploads/builds/tests)
  const uploadingRef = useRef<Set<string>>(new Set());
  const buildingRef = useRef<Set<string>>(new Set());
  const testingRef = useRef<Set<string>>(new Set());
  // Авто-продвижение init: запоминаем уже инициированные шаги, чтобы не звать
  // start_init_step повторно пока бэкенд не успел вернуть running.
  const advancedInitRef = useRef<Set<string>>(new Set());
  const testResultsRef = useRef<Map<string, TestCaptionResult>>(new Map());
  const [, forceRender] = useState(0);
  const bump = useCallback(() => forceRender((x) => x + 1), []);

  // init step tail positions (per pod+step)
  const tailPosRef = useRef<Map<string, number>>(new Map());

  function appendLog(key: string, chunk: string) {
    if (!chunk) return;
    const cur = (logsRef.current.get(key) ?? "") + chunk;
    const capped =
      cur.length > LOG_CAP ? cur.slice(cur.length - LOG_CAP) : cur;
    logsRef.current.set(key, capped);
    const subs = subsRef.current.get(key);
    if (subs) for (const fn of subs) fn(chunk);
  }

  function getLog(key: string): string {
    return logsRef.current.get(key) ?? "";
  }

  function subscribeLog(key: string, cb: (chunk: string) => void) {
    let set = subsRef.current.get(key);
    if (!set) {
      set = new Set();
      subsRef.current.set(key, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
    };
  }

  function clearLog(key: string) {
    logsRef.current.delete(key);
    const subs = subsRef.current.get(key);
    // notify subscribers with empty marker — they should re-read
    if (subs) for (const fn of subs) fn("\x1b[2J\x1b[H");
  }

  // Один раз — слушаем все события Tauri.
  // StrictMode в dev двойно вызывает useEffect: cleanup может сработать
  // ДО того как `await listen(...)` зарезолвится → unlisten никогда не
  // вызывается → каждое событие ловится дважды и счётчики/прогресс пляшут.
  // Защищаемся флагом alive: если cleanup уже прошёл к моменту резолва,
  // сразу же отписываемся.
  useEffect(() => {
    let alive = true;
    const cleanups: Array<() => void> = [];
    const track = (u: () => void) => {
      if (!alive) {
        u();
      } else {
        cleanups.push(u);
      }
    };

    (async () => {
      // BUILD: rich-state listeners
      track(
        await listen<{ project: string; videos: number }>(
          "ds_build:start",
          (e) => {
            updateBuild(e.payload.project, (_) => ({
              project: e.payload.project,
              status: "running",
              total_clips: 0,
              done_clips: 0,
              videos_total: e.payload.videos,
              videos_done: 0,
              clips_per_video: {},
              clip_done_per_video: {},
              parts: [],
              zip_path: undefined,
              error: undefined,
              started_at: Date.now(),
            }));
          },
        ),
      );
      track(
        await listen<{ project: string; line: string }>(
          "ds_build:log",
          (e) =>
            appendLog(buildKey(e.payload.project), e.payload.line + "\r\n"),
        ),
      );
      track(
        await listen<{
          project: string;
          name: string;
          clips: number;
          index: number;
        }>("ds_build:video", (e) => {
          updateBuild(e.payload.project, (b) => ({
            ...b,
            total_clips: b.total_clips + (e.payload.clips ?? 0),
            clips_per_video: {
              ...b.clips_per_video,
              [e.payload.index]: e.payload.clips ?? 0,
            },
          }));
          appendLog(
            buildKey(e.payload.project),
            `[${e.payload.name}] ${e.payload.clips} clip(s)\r\n`,
          );
        }),
      );
      track(
        await listen<{
          project: string;
          name: string;
          clip: number;
          of: number;
          video_index: number;
        }>("ds_build:clip_start", (e) => {
          updateBuild(e.payload.project, (b) => ({
            ...b,
            parts: [
              ...b.parts,
              {
                name: `${e.payload.name}_part${e.payload.clip}.mp4`,
                video: e.payload.name,
                clip: e.payload.clip,
                of: e.payload.of,
                status: "running",
              },
            ],
          }));
        }),
      );
      track(
        await listen<{
          project: string;
          clip: number;
          total_clips: number;
          video_index: number;
        }>("ds_build:clip_done", (e) => {
          updateBuild(e.payload.project, (b) => {
            const parts = [...b.parts];
            for (let i = parts.length - 1; i >= 0; i--) {
              if (parts[i].status === "running") {
                parts[i] = { ...parts[i], status: "done" };
                break;
              }
            }
            const vi = e.payload.video_index;
            const clipsDoneNext = (b.clip_done_per_video[vi] ?? 0) + 1;
            const clipsTotal = b.clips_per_video[vi] ?? 0;
            const videoFinished =
              clipsTotal > 0 && clipsDoneNext >= clipsTotal;
            return {
              ...b,
              parts,
              done_clips: b.done_clips + 1,
              clip_done_per_video: {
                ...b.clip_done_per_video,
                [vi]: clipsDoneNext,
              },
              videos_done: b.videos_done + (videoFinished ? 1 : 0),
            };
          });
        }),
      );
      track(
        await listen<{ project: string }>("ds_build:zipping", (e) => {
          updateBuild(e.payload.project, (b) => ({ ...b, status: "zipping" }));
          appendLog(buildKey(e.payload.project), `\r\n[zipping...]\r\n`);
        }),
      );
      track(
        await listen<{ project: string; zip_path: string }>(
          "ds_build:done",
          (e) => {
            updateBuild(e.payload.project, (b) => ({
              ...b,
              status: "done",
              zip_path: e.payload.zip_path,
            }));
          },
        ),
      );

      // UPLOAD logs
      track(
        await listen<{
          pod_id: string;
          project: string;
          line: string;
          side?: string;
        }>("ds_upload:log", (e) => {
          const tag =
            e.payload.side === "send"
              ? "» "
              : e.payload.side === "receive"
              ? "« "
              : "  ";
          appendLog(
            uploadKey(e.payload.pod_id, e.payload.project),
            tag + e.payload.line + "\r\n",
          );
        }),
      );
      track(
        await listen<{ pod_id: string; project: string; phase: string }>(
          "ds_upload:phase",
          (e) =>
            appendLog(
              uploadKey(e.payload.pod_id, e.payload.project),
              `# phase: ${e.payload.phase}\r\n`,
            ),
        ),
      );
      track(
        await listen<{ pod_id: string; project: string; code: string }>(
          "ds_upload:got_code",
          (e) =>
            appendLog(
              uploadKey(e.payload.pod_id, e.payload.project),
              `# code: ${e.payload.code}\r\n`,
            ),
        ),
      );

      // TEST CAPTION logs
      track(
        await listen<{ pod_id: string; project: string; line: string }>(
          "ds_caption_test:log",
          (e) =>
            appendLog(
              testCaptionKey(e.payload.pod_id, e.payload.project),
              e.payload.line,
            ),
        ),
      );
    })();

    return () => {
      alive = false;
      cleanups.forEach((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tick: poll init/caption state, accumulate tail logs
  const tick = useCallback(async () => {
    if (ticking.current) return;
    ticking.current = true;
    try {
      const apiKey = (await store.get<string>("runpod_key")) ?? "";
      const hfToken = (await store.get<string>("hf_token")) ?? "";
      if (!apiKey) {
        prevKeysRef.current = new Map();
        setTasks([]);
        setByPod(new Map());
        return;
      }
      const managed: ManagedPod[] = await loadManaged();
      const projectNames = await listProjects().catch(() => []);
      const projectObjs: Project[] = [];
      for (const n of projectNames) {
        try {
          projectObjs.push(await loadProject(n));
        } catch {
          /* skip */
        }
      }

      const next: PodTask[] = [];

      // SSH probes (параллельно с остальным)
      const probesPending = managed.map(async (pod) => {
        try {
          const r = await invoke<SshProbeCached>("pod_ssh_probe", {
            apiKey,
            podId: pod.id,
          });
          sshProbesRef.current.set(pod.id, r);
        } catch (e: any) {
          sshProbesRef.current.set(pod.id, {
            ok: false,
            host: "",
            port: 0,
            user: pod.id,
            key_used: null,
            error: String(e),
          });
        }
      });

      // INIT
      await Promise.all(
        managed.map(async (pod) => {
          try {
            const init = await invoke<InitState>("check_init_state", {
              apiKey,
              podId: pod.id,
            });
            const states = INIT_STEPS.map(
              (s) => init.steps[s]?.state ?? "pending",
            );
            const runningIdx = states.indexOf("running");
            const failedIdx = states.indexOf("failed");
            const lastDoneIdx = states.lastIndexOf("done");

            // Авто-продвижение: если предыдущий шаг done и следующий pending —
            // стартуем его сами.
            if (
              runningIdx === -1 &&
              failedIdx === -1 &&
              lastDoneIdx >= 0 &&
              lastDoneIdx + 1 < INIT_STEPS.length
            ) {
              const nextStep = INIT_STEPS[lastDoneIdx + 1];
              const startKey = `${pod.id}:${nextStep}`;
              if (!advancedInitRef.current.has(startKey)) {
                advancedInitRef.current.add(startKey);
                invoke("start_init_step", {
                  args: {
                    api_key: apiKey,
                    pod_id: pod.id,
                    step: nextStep,
                    hf_token: hfToken,
                  },
                })
                  .catch(() => {
                    advancedInitRef.current.delete(startKey);
                  })
                  .finally(() => {
                    // через 30с разрешаем повторно стартовать (на случай если
                    // прошлый старт молча провалился)
                    setTimeout(
                      () => advancedInitRef.current.delete(startKey),
                      30_000,
                    );
                  });
              }
            }
            // Очищаем флаг автостарта когда шаг подхватился (стал running/done/failed)
            if (runningIdx >= 0) {
              const stepName = INIT_STEPS[runningIdx];
              advancedInitRef.current.delete(`${pod.id}:${stepName}`);
            }

            if (runningIdx >= 0) {
              const stepName = INIT_STEPS[runningIdx];
              const k = initStepKey(pod.id, stepName);
              const since = tailPosRef.current.get(k) ?? 0;
              try {
                const r = await invoke<{ total: number; content: string }>(
                  "tail_init_log",
                  { apiKey, podId: pod.id, step: stepName, since },
                );
                if (r.content) appendLog(k, r.content);
                tailPosRef.current.set(k, r.total);
              } catch {
                /* ignore */
              }
              const progKind: ProgressKind = `init_${stepName}` as ProgressKind;
              const p = parseProgress(progKind, getLog(k));
              next.push({
                kind: "init",
                pod_id: pod.id,
                pod_name: pod.name || pod.id,
                state: "running",
                label: `init · ${stepName}`,
                progress: p?.pct,
                progress_label: p?.label,
                step_index: runningIdx + 1,
                step_total: INIT_STEPS.length,
                step_name: stepName,
                log_key: k,
                progress_kind: progKind,
              });
            } else if (failedIdx >= 0) {
              const stepName = INIT_STEPS[failedIdx];
              // дотянуть хвост — там сообщение об ошибке
              const k = initStepKey(pod.id, stepName);
              const since = tailPosRef.current.get(k) ?? 0;
              try {
                const r = await invoke<{ total: number; content: string }>(
                  "tail_init_log",
                  { apiKey, podId: pod.id, step: stepName, since },
                );
                if (r.content) appendLog(k, r.content);
                tailPosRef.current.set(k, r.total);
              } catch {
                /* ignore */
              }
              next.push({
                kind: "init",
                pod_id: pod.id,
                pod_name: pod.name || pod.id,
                state: "failed",
                label: `init · ${stepName}`,
                step_index: failedIdx + 1,
                step_total: INIT_STEPS.length,
                step_name: stepName,
              });
            }
          } catch {
            /* SSH not ready */
          }
        }),
      );

      // CAPTION (per uploaded project)
      await Promise.all(
        managed.flatMap((pod) =>
          projectObjs
            .filter((p) => !!p.last_uploads?.[pod.id])
            .map(async (proj) => {
              try {
                const cap = await invoke<CaptionState>(
                  "check_caption_state",
                  {
                    apiKey,
                    podId: pod.id,
                    projectName: proj.name,
                  },
                );
                if (cap.state === "running") {
                  const k = captionKey(pod.id, proj.name);
                  const since = tailPosRef.current.get(k) ?? 0;
                  try {
                    const r = await invoke<{ total: number; content: string }>(
                      "tail_caption_log",
                      {
                        apiKey,
                        podId: pod.id,
                        projectName: proj.name,
                        since,
                      },
                    );
                    if (r.content) appendLog(k, r.content);
                    tailPosRef.current.set(k, r.total);
                  } catch {
                    /* ignore */
                  }
                  const p = parseProgress("caption", getLog(k));
                  next.push({
                    kind: "caption",
                    pod_id: pod.id,
                    pod_name: pod.name || pod.id,
                    project_name: proj.name,
                    state: "running",
                    label: `caption · ${proj.name}`,
                    progress: p?.pct,
                    progress_label: p?.label,
                    log_key: k,
                    progress_kind: "caption",
                  });
                } else if (cap.state === "failed") {
                  const k = captionKey(pod.id, proj.name);
                  const since = tailPosRef.current.get(k) ?? 0;
                  try {
                    const r = await invoke<{ total: number; content: string }>(
                      "tail_caption_log",
                      { apiKey, podId: pod.id, projectName: proj.name, since },
                    );
                    if (r.content) appendLog(k, r.content);
                    tailPosRef.current.set(k, r.total);
                  } catch {
                    /* ignore */
                  }
                  next.push({
                    kind: "caption",
                    pod_id: pod.id,
                    pod_name: pod.name || pod.id,
                    project_name: proj.name,
                    state: "failed",
                    label: `caption · ${proj.name}`,
                  });
                }
              } catch {
                /* ignore */
              }
            }),
        ),
      );

      // include local tasks (upload/build/test) into pills
      for (const k of uploadingRef.current) {
        const [, pod_id, ...rest] = k.split(":");
        const project = rest.join(":");
        const pod = managed.find((m) => m.id === pod_id);
        const p = parseProgress("upload", getLog(k));
        next.push({
          kind: "upload",
          pod_id,
          pod_name: pod?.name || pod_id,
          project_name: project,
          state: "running",
          label: `upload · ${project}`,
          progress: p?.pct,
          progress_label: p?.label,
          log_key: k,
          progress_kind: "upload",
        });
      }
      for (const project of buildingRef.current) {
        next.push({
          kind: "build",
          pod_name: "",
          project_name: project,
          state: "running",
          label: `build · ${project}`,
        });
      }
      for (const k of testingRef.current) {
        const [, pod_id, ...rest] = k.split(":");
        const project = rest.join(":");
        const pod = managed.find((m) => m.id === pod_id);
        next.push({
          kind: "test_caption",
          pod_id,
          pod_name: pod?.name || pod_id,
          project_name: project,
          state: "running",
          label: `test · ${project}`,
        });
      }

      // detect transitions
      const keyed = new Map<string, PodTask>();
      for (const t of next) keyed.set(taskKey(t), t);

      for (const [key, prev] of prevKeysRef.current) {
        if (prev.state !== "running") continue;
        // Локальные задачи (upload/build/test_caption) сами шлют notify
        // в start*-методах — здесь дублировать не нужно.
        if (
          prev.kind === "upload" ||
          prev.kind === "build" ||
          prev.kind === "test_caption"
        )
          continue;
        const cur = keyed.get(key);
        if (!cur) {
          fireDoneNotification(prev, t);
        } else if (cur.state === "failed") {
          fireFailedNotification(prev, t);
        }
      }
      prevKeysRef.current = keyed;
      setTasks(next);
      const bucket = new Map<string, PodTask[]>();
      for (const t of next) {
        const id = t.pod_id ?? "_";
        const arr = bucket.get(id) ?? [];
        arr.push(t);
        bucket.set(id, arr);
      }
      setByPod(bucket);

      await Promise.all(probesPending);
      setSshProbes(new Map(sshProbesRef.current));
    } finally {
      ticking.current = false;
    }
  }, []);

  useEffect(() => {
    tick();
    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [tick]);

  // ─── start methods ────────────────────────────────────────────────────────

  const startUpload = useCallback(
    async (args: {
      api_key: string;
      pod_id: string;
      project_name: string;
    }) => {
      const k = uploadKey(args.pod_id, args.project_name);
      if (uploadingRef.current.has(k)) {
        return { ok: false, error: "already uploading" };
      }
      uploadingRef.current.add(k);
      clearLog(k);
      bump();
      try {
        await invoke("upload_dataset", {
          apiKey: args.api_key,
          podId: args.pod_id,
          projectName: args.project_name,
        });
        appendLog(k, `\r\n# upload finished\r\n`);
        invoke("notify", {
          title: t("notify.upload_done"),
          body: `${args.project_name}`,
        }).catch(() => {});
        return { ok: true };
      } catch (e: any) {
        const err = String(e);
        appendLog(k, `\r\n# upload failed: ${err}\r\n`);
        invoke("notify", {
          title: t("notify.upload_failed"),
          body: `${args.project_name}: ${err}`,
        }).catch(() => {});
        return { ok: false, error: err };
      } finally {
        uploadingRef.current.delete(k);
        bump();
        tick();
      }
    },
    [tick, bump],
  );

  const startBuild = useCallback(
    async (args: { project_name: string; hash: string }) => {
      const k = buildKey(args.project_name);
      if (buildingRef.current.has(args.project_name)) {
        return { ok: false, error: "already building" };
      }
      buildingRef.current.add(args.project_name);
      clearLog(k);
      bump();
      try {
        await invoke("build_dataset", {
          projectName: args.project_name,
          hash: args.hash,
        });
        appendLog(k, `\r\n# build finished\r\n`);
        invoke("notify", {
          title: t("notify.build_done"),
          body: args.project_name,
        }).catch(() => {});
        return { ok: true };
      } catch (e: any) {
        const err = String(e);
        appendLog(k, `\r\n# build failed: ${err}\r\n`);
        // помечаем последний running part как failed и общий статус
        updateBuild(args.project_name, (b) => {
          const parts = [...b.parts];
          for (let i = parts.length - 1; i >= 0; i--) {
            if (parts[i].status === "running") {
              parts[i] = { ...parts[i], status: "failed" };
              break;
            }
          }
          return { ...b, parts, status: "failed", error: err };
        });
        invoke("notify", {
          title: t("notify.build_failed"),
          body: `${args.project_name}: ${err}`,
        }).catch(() => {});
        return { ok: false, error: err };
      } finally {
        buildingRef.current.delete(args.project_name);
        bump();
        tick();
      }
    },
    [tick, bump, updateBuild],
  );

  const startTestCaption = useCallback(
    async (args: {
      api_key: string;
      pod_id: string;
      project_name: string;
      provider: string;
      instructions?: string | null;
      audio?: boolean;
      gemini_api_key?: string | null;
    }) => {
      const k = testCaptionKey(args.pod_id, args.project_name);
      if (testingRef.current.has(k)) {
        return { ok: false, error: "already testing" };
      }
      testingRef.current.add(k);
      testResultsRef.current.delete(k);
      clearLog(k);
      bump();
      try {
        const res = await invoke<{
          caption: string;
          clip_filename: string;
        }>("test_caption", {
          args: {
            api_key: args.api_key,
            pod_id: args.pod_id,
            project_name: args.project_name,
            provider: args.provider,
            instructions: args.instructions,
            audio: args.audio,
            gemini_api_key: args.gemini_api_key,
          },
        });
        // download clip
        let video_b64: string | undefined;
        let video_mime: string | undefined;
        try {
          const clip = await invoke<{
            mime: string;
            b64: string;
            size: number;
          }>("read_pod_clip", {
            apiKey: args.api_key,
            podId: args.pod_id,
            projectName: args.project_name,
            filename: res.clip_filename,
          });
          video_b64 = clip.b64;
          video_mime = clip.mime;
        } catch {
          /* ignore */
        }
        testResultsRef.current.set(k, { ...res, video_b64, video_mime });
        appendLog(k, `\r\n# test finished\r\n`);
        invoke("notify", {
          title: t("notify.test_done"),
          body: `${args.project_name}`,
        }).catch(() => {});
        return { ok: true };
      } catch (e: any) {
        const err = String(e);
        appendLog(k, `\r\n# test failed: ${err}\r\n`);
        return { ok: false, error: err };
      } finally {
        testingRef.current.delete(k);
        bump();
        tick();
      }
    },
    [tick, bump],
  );

  const isUploading = useCallback(
    (pod_id: string, project: string) =>
      uploadingRef.current.has(uploadKey(pod_id, project)),
    [],
  );
  const isBuilding = useCallback(
    (project: string) => buildingRef.current.has(project),
    [],
  );
  const isTesting = useCallback(
    (pod_id: string, project: string) =>
      testingRef.current.has(testCaptionKey(pod_id, project)),
    [],
  );
  const takeTestResult = useCallback(
    (pod_id: string, project: string) => {
      const k = testCaptionKey(pod_id, project);
      const r = testResultsRef.current.get(k) ?? null;
      if (r) testResultsRef.current.delete(k);
      return r;
    },
    [],
  );

  const api: TasksApi = {
    tasks,
    byPod,
    sshProbes,
    getSshProbe: (pod_id: string) => sshProbesRef.current.get(pod_id) ?? null,
    builds,
    refresh: tick,
    getLog,
    subscribeLog,
    isUploading,
    isBuilding,
    isTesting,
    takeTestResult,
    startUpload,
    startBuild,
    startTestCaption,
  };

  return <TasksContext.Provider value={api}>{children}</TasksContext.Provider>;
}

function taskKey(t: PodTask): string {
  return `${t.kind}:${t.pod_id ?? ""}:${t.project_name ?? ""}`;
}

function fireDoneNotification(
  task: PodTask,
  t: (k: string) => string,
) {
  const titles: Record<TaskKind, string> = {
    init: t("notify.init_done"),
    caption: t("notify.caption_done"),
    upload: t("notify.upload_done"),
    build: t("notify.build_done"),
    test_caption: t("notify.test_done"),
  };
  const body = [
    task.project_name ?? "",
    task.pod_name && task.pod_name !== task.pod_id
      ? task.pod_name
      : task.pod_id ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
  invoke("notify", { title: titles[task.kind], body }).catch(() => {});
}

function fireFailedNotification(
  task: PodTask,
  t: (k: string) => string,
) {
  const titles: Record<TaskKind, string> = {
    init: t("notify.init_failed"),
    caption: t("notify.caption_failed"),
    upload: t("notify.upload_failed"),
    build: t("notify.build_failed"),
    test_caption: t("notify.test_failed"),
  };
  const body = [
    task.project_name ?? "",
    task.pod_name && task.pod_name !== task.pod_id
      ? task.pod_name
      : task.pod_id ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
  invoke("notify", { title: titles[task.kind], body }).catch(() => {});
}
