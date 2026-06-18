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
import {
  loadManaged,
  ManagedPod,
  NvidiaInfo,
  Pod,
  saveManaged,
  SshProbe,
  store,
} from "./pods";
import {
  checkLocalTools,
  installFfmpeg as invokeInstallFfmpeg,
  installRunpodctl as invokeInstallRunpodctl,
  listProjects,
  loadProject,
  LocalTools,
  Project,
  saveProject as invokeSaveProject,
} from "./projects";
import { parseProgress, Progress, ProgressKind } from "./progress";

// ──────────────────────────────────────────────────────────────────────────
// Public API types
// ──────────────────────────────────────────────────────────────────────────

export type TaskKind =
  | "init"
  | "caption"
  | "upload"
  | "build"
  | "test_caption"
  | "train";

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
  clips_per_video: Record<number, number>;
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
  progress?: number;
  progress_label?: string;
  step_index?: number;
  step_total?: number;
  step_name?: string;
  log_key?: string;
  progress_kind?: ProgressKind;
}

interface TestCaptionResult {
  caption: string;
  clip_filename: string;
  video_b64?: string;
  video_mime?: string;
}

export interface InitStepStatus {
  state: "pending" | "running" | "done" | "failed";
  exit_code?: number | null;
  log_size: number;
}

export interface InitState {
  tmux_available: boolean;
  steps: Record<string, InitStepStatus>;
}

export interface CaptionStatus {
  state: "pending" | "running" | "done" | "failed";
  exit_code?: number | null;
  log_size: number;
}

export type TrainingPhase =
  | "prep"
  | "preprocess"
  | "vram_clear"
  | "train"
  | "done";

export interface PreprocessProgress {
  /** "captions" | "videos" */
  kind: string;
  done: number;
  total: number;
}

export interface ValidationProgress {
  sample: number;
  samples_total: number;
  inf_step: number;
  inf_total: number;
  eta?: string | null;
}

export interface TrainingState {
  state: "pending" | "running" | "done" | "failed";
  log_size: number;
  exit_code?: number | null;
  phase?: TrainingPhase | string | null;
  step?: number | null;
  total_steps?: number | null;
  eta?: string | null;
  loss?: number | null;
  step_time?: string | null;
  lr?: string | null;
  preprocess_progress?: PreprocessProgress | null;
  validation_progress?: ValidationProgress | null;
  validations_done: number[];
  current_validation?: number | null;
  error?: string | null;
  /** "oom" | "preprocess" | "media_mismatch" | "train" | "other" */
  error_kind?: string | null;
}

export interface InstallState {
  running: boolean;
  log: string | null;
}

export interface TasksApi {
  // secrets
  apiKey: string | null;
  hfToken: string;
  geminiKey: string;
  reloadSecrets: () => Promise<void>;

  // preferences
  notificationsEnabled: boolean;
  setNotificationsEnabled: (v: boolean) => Promise<void>;

  // pods
  pods: Map<string, Pod>;
  managed: ManagedPod[];
  reloadPods: () => Promise<void>;
  setManaged: (next: ManagedPod[]) => Promise<void>;

  // ssh / nvidia
  sshProbes: Map<string, SshProbe>;
  nvidia: Map<string, NvidiaInfo>;

  // projects
  projectList: string[] | null;
  projects: Map<string, Project>;
  reloadProjectList: () => Promise<void>;
  loadProjectByName: (name: string) => Promise<Project | null>;
  saveProject: (p: Project) => Promise<Project>;

  // local tools
  localTools: LocalTools | null;
  installing: Record<"ffmpeg" | "runpodctl", InstallState>;
  reloadLocalTools: () => Promise<void>;
  installFfmpeg: () => Promise<void>;
  installRunpodctl: () => Promise<void>;

  // tasks
  tasks: PodTask[];
  byPod: Map<string, PodTask[]>;
  builds: Map<string, BuildState>;
  initStates: Map<string, InitState>;
  captionStatuses: Map<string, CaptionStatus>;
  trainingStates: Map<string, TrainingState>;
  refresh: () => void;

  // log subs
  getLog: (key: string) => string;
  subscribeLog: (key: string, cb: (chunk: string) => void) => () => void;

  // local long-running
  isUploading: (pod_id: string, project: string) => boolean;
  isBuilding: (project: string) => boolean;
  isTesting: (pod_id: string, project: string) => boolean;
  takeTestResult: (
    pod_id: string,
    project: string,
  ) => TestCaptionResult | null;

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
  startTraining: (args: {
    api_key: string;
    pod_id: string;
    project_name: string;
    rank: number;
    mode: string;
    steps: number;
    trigger_word?: string | null;
    validation_prompts?: string[];
    validation_images?: string[];
    enable_gradient_checkpointing?: boolean;
    load_text_encoder_in_8bit?: boolean;
    expandable_segments?: boolean;
    audio: boolean;
    clip_count: number;
    buckets: Array<[number, number, number]>;
    raw_config_yaml?: string | null;
  }) => Promise<{ ok: boolean; error?: string }>;
  exportTrainingConfig: (args: {
    api_key: string;
    pod_id: string;
    project_name: string;
    rank: number;
    mode: string;
    steps: number;
    trigger_word?: string | null;
    validation_prompts?: string[];
    validation_images?: string[];
    enable_gradient_checkpointing?: boolean;
    load_text_encoder_in_8bit?: boolean;
    expandable_segments?: boolean;
    audio: boolean;
    clip_count: number;
    buckets: Array<[number, number, number]>;
  }) => Promise<string>;
  resetTraining: (pod_id: string, project: string) => Promise<void>;
}

const TasksContext = createContext<TasksApi | null>(null);
export const useTasks = (): TasksApi => {
  const v = useContext(TasksContext);
  if (!v) throw new Error("useTasks outside provider");
  return v;
};

// ──────────────────────────────────────────────────────────────────────────
// Convenience hooks (1-line reads)
// ──────────────────────────────────────────────────────────────────────────

export function usePod(id: string | null | undefined): Pod | null {
  const t = useTasks();
  if (!id) return null;
  return t.pods.get(id) ?? null;
}

export function useManagedPod(id: string | null | undefined): ManagedPod | null {
  const t = useTasks();
  if (!id) return null;
  return t.managed.find((m) => m.id === id) ?? null;
}

export function useSshProbe(id: string | null | undefined): SshProbe | null {
  const t = useTasks();
  if (!id) return null;
  return t.sshProbes.get(id) ?? null;
}

export function useNvidia(id: string | null | undefined): NvidiaInfo | null {
  const t = useTasks();
  if (!id) return null;
  return t.nvidia.get(id) ?? null;
}

export function useProject(name: string | null | undefined): Project | null {
  const t = useTasks();
  if (!name) return null;
  return t.projects.get(name) ?? null;
}

export function useInitState(podId: string | null | undefined): InitState | null {
  const t = useTasks();
  if (!podId) return null;
  return t.initStates.get(podId) ?? null;
}

export function useCaptionStatus(
  podId: string | null | undefined,
  project: string | null | undefined,
): CaptionStatus | null {
  const t = useTasks();
  if (!podId || !project) return null;
  return t.captionStatuses.get(`${podId}:${project}`) ?? null;
}

export function useTrainingState(
  podId: string | null | undefined,
  project: string | null | undefined,
): TrainingState | null {
  const t = useTasks();
  if (!podId || !project) return null;
  return t.trainingStates.get(`${podId}:${project}`) ?? null;
}

/** Live-парсинг прогресса из лог-буфера задачи. */
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
      setP(parseProgress(kind, tasks.getLog(log_key)));
    };
    recompute();
    const unsub = tasks.subscribeLog(log_key, () => recompute());
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log_key, kind]);
  return p;
}

// ──────────────────────────────────────────────────────────────────────────
// Constants & key helpers
// ──────────────────────────────────────────────────────────────────────────

const INIT_STEPS = ["packages", "env", "model", "encoder", "verify"] as const;
const POLL_INTERVAL_MS = 5_000;
const LOG_CAP = 200_000;

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
export function trainKey(pod_id: string, project: string) {
  return `train:${pod_id}:${project}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Provider
// ──────────────────────────────────────────────────────────────────────────

export function TasksProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();

  // ---- secrets
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [hfToken, setHfToken] = useState<string>("");
  const [geminiKey, setGeminiKey] = useState<string>("");
  const apiKeyRef = useRef<string | null>(null);
  const hfTokenRef = useRef<string>("");
  const geminiKeyRef = useRef<string>("");

  const reloadSecrets = useCallback(async () => {
    const k = (await store.get<string>("runpod_key")) ?? "";
    const hf = (await store.get<string>("hf_token")) ?? "";
    const gk = (await store.get<string>("gemini_key")) ?? "";
    setApiKey(k || null);
    setHfToken(hf);
    setGeminiKey(gk);
    apiKeyRef.current = k || null;
    hfTokenRef.current = hf;
    geminiKeyRef.current = gk;
  }, []);

  useEffect(() => {
    reloadSecrets();
  }, [reloadSecrets]);

  // ---- preferences (notifications)
  const [notificationsEnabled, setNotificationsEnabledState] = useState(true);
  const notificationsEnabledRef = useRef(true);
  useEffect(() => {
    (async () => {
      const v = (await store.get<boolean>("notifications_enabled")) ?? true;
      setNotificationsEnabledState(v);
      notificationsEnabledRef.current = v;
    })();
  }, []);
  const setNotificationsEnabled = useCallback(async (v: boolean) => {
    setNotificationsEnabledState(v);
    notificationsEnabledRef.current = v;
    await store.set("notifications_enabled", v);
    await store.save();
  }, []);
  const notify = useCallback((title: string, body: string) => {
    if (!notificationsEnabledRef.current) return;
    invoke("notify", { title, body }).catch(() => {});
  }, []);

  // ---- pods (live + managed)
  const [pods, setPods] = useState<Map<string, Pod>>(new Map());
  const [managed, setManagedState] = useState<ManagedPod[]>([]);
  const reloadPods = useCallback(async () => {
    const list = await loadManaged();
    setManagedState(list);
    if (apiKeyRef.current) {
      try {
        const live = await invoke<Pod[]>("list_pods", {
          apiKey: apiKeyRef.current,
        });
        const m = new Map<string, Pod>();
        for (const p of live) m.set(p.id, p);
        setPods(m);
      } catch {
        /* ignore */
      }
    }
  }, []);
  const setManaged = useCallback(async (next: ManagedPod[]) => {
    setManagedState(next);
    await saveManaged(next);
  }, []);

  useEffect(() => {
    if (apiKey) reloadPods();
  }, [apiKey, reloadPods]);

  // ---- ssh probes / nvidia
  const [sshProbes, setSshProbes] = useState<Map<string, SshProbe>>(new Map());
  const sshProbesRef = useRef<Map<string, SshProbe>>(new Map());
  const [nvidia, setNvidia] = useState<Map<string, NvidiaInfo>>(new Map());
  const nvidiaRef = useRef<Map<string, NvidiaInfo>>(new Map());

  // ---- projects
  const [projectList, setProjectList] = useState<string[] | null>(null);
  const [projects, setProjects] = useState<Map<string, Project>>(new Map());
  const projectsRef = useRef<Map<string, Project>>(new Map());

  const reloadProjectList = useCallback(async () => {
    try {
      const list = await listProjects();
      setProjectList(list);
    } catch {
      setProjectList([]);
    }
  }, []);

  const loadProjectByName = useCallback(
    async (name: string): Promise<Project | null> => {
      try {
        const p = await loadProject(name);
        projectsRef.current.set(p.name, p);
        setProjects(new Map(projectsRef.current));
        return p;
      } catch {
        return null;
      }
    },
    [],
  );

  const saveProject = useCallback(async (p: Project): Promise<Project> => {
    const saved = await invokeSaveProject(p);
    projectsRef.current.set(saved.name, saved);
    setProjects(new Map(projectsRef.current));
    return saved;
  }, []);

  useEffect(() => {
    reloadProjectList();
  }, [reloadProjectList]);

  // ---- local tools
  const [localTools, setLocalTools] = useState<LocalTools | null>(null);
  const [installing, setInstallingMap] = useState<
    Record<"ffmpeg" | "runpodctl", InstallState>
  >({
    ffmpeg: { running: false, log: null },
    runpodctl: { running: false, log: null },
  });
  const installingRef = useRef(installing);
  installingRef.current = installing;

  const reloadLocalTools = useCallback(async () => {
    try {
      setLocalTools(await checkLocalTools());
    } catch {
      /* ignore */
    }
  }, []);

  const setInstallState = useCallback(
    (which: "ffmpeg" | "runpodctl", patch: Partial<InstallState>) => {
      const next = {
        ...installingRef.current,
        [which]: { ...installingRef.current[which], ...patch },
      };
      installingRef.current = next;
      setInstallingMap(next);
    },
    [],
  );

  const installFfmpeg = useCallback(async () => {
    if (installingRef.current.ffmpeg.running) return;
    setInstallState("ffmpeg", { running: true, log: null });
    try {
      const out = await invokeInstallFfmpeg();
      setInstallState("ffmpeg", { running: false, log: out });
      await reloadLocalTools();
    } catch (e: any) {
      setInstallState("ffmpeg", { running: false, log: String(e) });
    }
  }, [setInstallState, reloadLocalTools]);

  const installRunpodctl = useCallback(async () => {
    if (installingRef.current.runpodctl.running) return;
    setInstallState("runpodctl", { running: true, log: null });
    try {
      const out = await invokeInstallRunpodctl();
      setInstallState("runpodctl", { running: false, log: out });
      await reloadLocalTools();
    } catch (e: any) {
      setInstallState("runpodctl", { running: false, log: String(e) });
    }
  }, [setInstallState, reloadLocalTools]);

  useEffect(() => {
    reloadLocalTools();
  }, [reloadLocalTools]);

  // ---- builds
  const [builds, setBuilds] = useState<Map<string, BuildState>>(new Map());
  const buildsRef = useRef<Map<string, BuildState>>(new Map());
  const updateBuild = useCallback(
    (projectRaw: string | undefined, mut: (b: BuildState) => BuildState) => {
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
      const cur =
        buildsRef.current.get(project) ??
        ({
          project,
          status: "running" as const,
          total_clips: 0,
          done_clips: 0,
          videos_done: 0,
          clips_per_video: {},
          clip_done_per_video: {},
          parts: [],
          started_at: Date.now(),
        } as BuildState);
      const next = mut(cur);
      buildsRef.current.set(project, next);
      setBuilds(new Map(buildsRef.current));
    },
    [],
  );

  // ---- task list
  const [tasks, setTasks] = useState<PodTask[]>([]);
  const [byPod, setByPod] = useState<Map<string, PodTask[]>>(new Map());
  const [initStates, setInitStates] = useState<Map<string, InitState>>(new Map());
  const initStatesRef = useRef<Map<string, InitState>>(new Map());
  const [captionStatuses, setCaptionStatuses] = useState<
    Map<string, CaptionStatus>
  >(new Map());
  const captionStatusesRef = useRef<Map<string, CaptionStatus>>(new Map());
  const [trainingStates, setTrainingStates] = useState<
    Map<string, TrainingState>
  >(new Map());
  const trainingStatesRef = useRef<Map<string, TrainingState>>(new Map());
  // Чтобы не дублировать уведомления о завершении валидации, помним какие
  // checkpoint-step'ы уже «прозвенели».
  const validationsNotifiedRef = useRef<Map<string, Set<number>>>(new Map());

  const prevKeysRef = useRef<Map<string, PodTask>>(new Map());
  const ticking = useRef(false);

  // log buffers + subscribers
  const logsRef = useRef<Map<string, string>>(new Map());
  const subsRef = useRef<Map<string, Set<(s: string) => void>>>(new Map());

  // local long-running tracking
  const uploadingRef = useRef<Set<string>>(new Set());
  const buildingRef = useRef<Set<string>>(new Set());
  const testingRef = useRef<Set<string>>(new Set());
  const advancedInitRef = useRef<Set<string>>(new Set());
  const testResultsRef = useRef<Map<string, TestCaptionResult>>(new Map());
  const [, forceRender] = useState(0);
  const bump = useCallback(() => forceRender((x) => x + 1), []);

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
    if (subs) for (const fn of subs) fn("\x1b[2J\x1b[H");
  }

  // ---- Tauri event listeners (build/upload/caption_test logs)
  useEffect(() => {
    let alive = true;
    const cleanups: Array<() => void> = [];
    const track = (u: () => void) => {
      if (!alive) u();
      else cleanups.push(u);
    };

    (async () => {
      // BUILD
      track(
        await listen<{ project: string; videos: number }>(
          "ds_build:start",
          (e) => {
            updateBuild(e.payload.project, () => ({
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
        await listen<{
          project: string;
          name: string;
          reason: string;
        }>("ds_build:skip", (e) => {
          const why =
            e.payload.reason === "no_audio"
              ? "no audio track (project has audio=on)"
              : e.payload.reason;
          appendLog(
            buildKey(e.payload.project),
            `[${e.payload.name}] SKIPPED: ${why}\r\n`,
          );
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

      // UPLOAD
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

      // TEST CAPTION
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

  // ---- main tick: live pods, ssh probes, nvidia, init/caption state, log tails
  const tick = useCallback(async () => {
    if (ticking.current) return;
    ticking.current = true;
    try {
      const ak = apiKeyRef.current ?? "";
      const hf = hfTokenRef.current;
      if (!ak) {
        prevKeysRef.current = new Map();
        setTasks([]);
        setByPod(new Map());
        return;
      }

      // live pods
      try {
        const live = await invoke<Pod[]>("list_pods", { apiKey: ak });
        const m = new Map<string, Pod>();
        for (const p of live) m.set(p.id, p);
        setPods(m);
      } catch {
        /* ignore */
      }

      const managedList: ManagedPod[] = await loadManaged();
      setManagedState(managedList);

      const projectNames = await listProjects().catch(() => []);
      const projectObjs: Project[] = [];
      for (const n of projectNames) {
        try {
          const p = await loadProject(n);
          projectObjs.push(p);
          projectsRef.current.set(p.name, p);
        } catch {
          /* skip */
        }
      }
      setProjects(new Map(projectsRef.current));
      setProjectList(projectNames);

      const next: PodTask[] = [];

      // SSH probes (parallel)
      const probesPending = managedList.map(async (pod) => {
        try {
          const r = await invoke<SshProbe>("pod_ssh_probe", {
            apiKey: ak,
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
        managedList.map(async (pod) => {
          try {
            const init = await invoke<InitState>("check_init_state", {
              apiKey: ak,
              podId: pod.id,
            });
            initStatesRef.current.set(pod.id, init);

            const states = INIT_STEPS.map(
              (s) => init.steps[s]?.state ?? "pending",
            );
            const runningIdx = states.indexOf("running");
            const failedIdx = states.indexOf("failed");
            const lastDoneIdx = states.lastIndexOf("done");

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
                    api_key: ak,
                    pod_id: pod.id,
                    step: nextStep,
                    hf_token: hf,
                  },
                })
                  .catch(() => {
                    advancedInitRef.current.delete(startKey);
                  })
                  .finally(() => {
                    setTimeout(
                      () => advancedInitRef.current.delete(startKey),
                      30_000,
                    );
                  });
              }
            }
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
                  { apiKey: ak, podId: pod.id, step: stepName, since },
                );
                if (r.content) appendLog(k, r.content);
                tailPosRef.current.set(k, r.total);
              } catch {
                /* ignore */
              }
              const progKind: ProgressKind =
                `init_${stepName}` as ProgressKind;
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
              const k = initStepKey(pod.id, stepName);
              const since = tailPosRef.current.get(k) ?? 0;
              try {
                const r = await invoke<{ total: number; content: string }>(
                  "tail_init_log",
                  { apiKey: ak, podId: pod.id, step: stepName, since },
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
      setInitStates(new Map(initStatesRef.current));

      // CAPTION (per uploaded project)
      await Promise.all(
        managedList.flatMap((pod) =>
          projectObjs
            .filter((p) => !!p.last_uploads?.[pod.id])
            .map(async (proj) => {
              try {
                const cap = await invoke<CaptionStatus>(
                  "check_caption_state",
                  {
                    apiKey: ak,
                    podId: pod.id,
                    projectName: proj.name,
                  },
                );
                captionStatusesRef.current.set(`${pod.id}:${proj.name}`, cap);
                if (cap.state === "running") {
                  const k = captionKey(pod.id, proj.name);
                  const since = tailPosRef.current.get(k) ?? 0;
                  try {
                    const r = await invoke<{ total: number; content: string }>(
                      "tail_caption_log",
                      {
                        apiKey: ak,
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
                      {
                        apiKey: ak,
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
      setCaptionStatuses(new Map(captionStatusesRef.current));

      // TRAINING (per uploaded project)
      await Promise.all(
        managedList.flatMap((pod) =>
          projectObjs
            .filter((p) => !!p.last_uploads?.[pod.id])
            .map(async (proj) => {
              try {
                const tr = await invoke<TrainingState>(
                  "check_training_state",
                  {
                    apiKey: ak,
                    podId: pod.id,
                    projectName: proj.name,
                  },
                );
                const key = `${pod.id}:${proj.name}`;
                // diff validations_done → уведомления на каждом новом checkpoint
                const prev = trainingStatesRef.current.get(key);
                const prevDone = new Set(prev?.validations_done ?? []);
                const seenSet =
                  validationsNotifiedRef.current.get(key) ?? new Set<number>();
                for (const s of tr.validations_done) {
                  if (!prevDone.has(s) && !seenSet.has(s)) {
                    seenSet.add(s);
                    notify(
                      t("notify.validation_done"),
                      `${proj.name} · step ${s}`,
                    );
                  }
                }
                validationsNotifiedRef.current.set(key, seenSet);
                trainingStatesRef.current.set(key, tr);
                if (tr.state === "running") {
                  const k = trainKey(pod.id, proj.name);
                  const since = tailPosRef.current.get(k) ?? 0;
                  try {
                    const r = await invoke<{ total: number; content: string }>(
                      "tail_training_log",
                      {
                        apiKey: ak,
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
                  // Прогресс badge'а зависит от текущей фазы:
                  // train  → step / total_steps
                  // preprocess → preprocess_progress.done / total
                  // иначе   → undefined (просто spinner)
                  let pct: number | undefined;
                  let pl = tr.phase ?? "";
                  if (tr.phase === "train" && (tr.total_steps ?? 0) > 0) {
                    pct = ((tr.step ?? 0) / (tr.total_steps as number)) * 100;
                    pl = `${tr.step ?? 0}/${tr.total_steps}`;
                  } else if (
                    tr.phase === "preprocess" &&
                    tr.preprocess_progress &&
                    tr.preprocess_progress.total > 0
                  ) {
                    pct =
                      (tr.preprocess_progress.done /
                        tr.preprocess_progress.total) *
                      100;
                    pl = `${tr.preprocess_progress.kind} ${tr.preprocess_progress.done}/${tr.preprocess_progress.total}`;
                  }
                  next.push({
                    kind: "train",
                    pod_id: pod.id,
                    pod_name: pod.name || pod.id,
                    project_name: proj.name,
                    state: "running",
                    label: `train · ${proj.name}`,
                    progress: pct,
                    progress_label: pl,
                    log_key: k,
                  });
                } else if (tr.state === "failed") {
                  next.push({
                    kind: "train",
                    pod_id: pod.id,
                    pod_name: pod.name || pod.id,
                    project_name: proj.name,
                    state: "failed",
                    label: `train · ${proj.name}`,
                  });
                }
              } catch {
                /* ignore */
              }
            }),
        ),
      );
      setTrainingStates(new Map(trainingStatesRef.current));

      // local tasks
      for (const k of uploadingRef.current) {
        const [, pod_id, ...rest] = k.split(":");
        const project = rest.join(":");
        const pod = managedList.find((m) => m.id === pod_id);
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
        const pod = managedList.find((m) => m.id === pod_id);
        next.push({
          kind: "test_caption",
          pod_id,
          pod_name: pod?.name || pod_id,
          project_name: project,
          state: "running",
          label: `test · ${project}`,
        });
      }

      // detect transitions for OS notifications (init/caption only — local
      // задачи notify-ят сами в start*-методах)
      const keyed = new Map<string, PodTask>();
      for (const t of next) keyed.set(taskKey(t), t);
      for (const [key, prev] of prevKeysRef.current) {
        if (prev.state !== "running") continue;
        if (
          prev.kind === "upload" ||
          prev.kind === "build" ||
          prev.kind === "test_caption"
        )
          continue;
        const cur = keyed.get(key);
        if (!cur) {
          fireNotify(prev, t, "done", notify);
        } else if (cur.state === "failed") {
          fireNotify(prev, t, "failed", notify);
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

      // nvidia for pods with healthy SSH
      await Promise.all(
        managedList.map(async (pod) => {
          const probe = sshProbesRef.current.get(pod.id);
          if (!probe?.ok) return;
          try {
            const n = await invoke<NvidiaInfo>("pod_nvidia_smi", {
              apiKey: ak,
              podId: pod.id,
            });
            nvidiaRef.current.set(pod.id, n);
          } catch {
            /* ignore */
          }
        }),
      );
      setNvidia(new Map(nvidiaRef.current));
    } finally {
      ticking.current = false;
    }
  }, []);

  useEffect(() => {
    tick();
    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [tick]);

  // ──────────────────────────────────────────────────────────────────────
  // Start methods
  // ──────────────────────────────────────────────────────────────────────

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
        notify(t("notify.upload_done"), args.project_name);
        return { ok: true };
      } catch (e: any) {
        const err = String(e);
        appendLog(k, `\r\n# upload failed: ${err}\r\n`);
        notify(t("notify.upload_failed"), `${args.project_name}: ${err}`);
        return { ok: false, error: err };
      } finally {
        uploadingRef.current.delete(k);
        bump();
        tick();
      }
    },
    [tick, bump, t],
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
        notify(t("notify.build_done"), args.project_name);
        return { ok: true };
      } catch (e: any) {
        const err = String(e);
        appendLog(k, `\r\n# build failed: ${err}\r\n`);
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
        notify(t("notify.build_failed"), `${args.project_name}: ${err}`);
        return { ok: false, error: err };
      } finally {
        buildingRef.current.delete(args.project_name);
        bump();
        tick();
      }
    },
    [tick, bump, t, updateBuild],
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
        notify(t("notify.test_done"), args.project_name);
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
    [tick, bump, t],
  );

  const startTraining = useCallback(
    async (args: {
      api_key: string;
      pod_id: string;
      project_name: string;
      rank: number;
      mode: string;
      steps: number;
      trigger_word?: string | null;
      validation_prompts?: string[];
      validation_images?: string[];
      enable_gradient_checkpointing?: boolean;
      load_text_encoder_in_8bit?: boolean;
      expandable_segments?: boolean;
      audio: boolean;
      clip_count: number;
      buckets: Array<[number, number, number]>;
      raw_config_yaml?: string | null;
    }) => {
      const k = trainKey(args.pod_id, args.project_name);
      const stateKey = `${args.pod_id}:${args.project_name}`;
      clearLog(k);
      validationsNotifiedRef.current.delete(stateKey);
      // Сразу очищаем старое состояние (если был failed/done от прошлого
      // прогона), чтобы вью не показывала ошибку поверх нового запуска.
      trainingStatesRef.current.delete(stateKey);
      setTrainingStates(new Map(trainingStatesRef.current));
      try {
        await invoke("start_training", {
          args: {
            api_key: args.api_key,
            pod_id: args.pod_id,
            project_name: args.project_name,
            rank: args.rank,
            mode: args.mode,
            steps: args.steps,
            trigger_word: args.trigger_word ?? null,
            validation_prompts: args.validation_prompts ?? [],
            validation_images: args.validation_images ?? [],
            enable_gradient_checkpointing:
              !!args.enable_gradient_checkpointing,
            load_text_encoder_in_8bit: !!args.load_text_encoder_in_8bit,
            expandable_segments: !!args.expandable_segments,
            audio: args.audio,
            clip_count: args.clip_count,
            buckets: args.buckets,
            raw_config_yaml: args.raw_config_yaml ?? null,
          },
        });
        // Optimistic update: tmux уже стартовал, но настоящий poll прилетит
        // только в следующий tick. Отмечаем состояние как running сразу,
        // чтобы settings-вью моментально схлопнулась в TrainingActive.
        trainingStatesRef.current.set(stateKey, {
          state: "running",
          log_size: 0,
          phase: "prep",
          validations_done: [],
        });
        setTrainingStates(new Map(trainingStatesRef.current));
        tick();
        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: String(e) };
      }
    },
    [tick],
  );

  const exportTrainingConfig = useCallback(
    async (args: {
      api_key: string;
      pod_id: string;
      project_name: string;
      rank: number;
      mode: string;
      steps: number;
      trigger_word?: string | null;
      validation_prompts?: string[];
      validation_images?: string[];
      enable_gradient_checkpointing?: boolean;
      load_text_encoder_in_8bit?: boolean;
      expandable_segments?: boolean;
      audio: boolean;
      clip_count: number;
      buckets: Array<[number, number, number]>;
    }) => {
      return await invoke<string>("export_training_config", {
        args: {
          api_key: args.api_key,
          pod_id: args.pod_id,
          project_name: args.project_name,
          rank: args.rank,
          mode: args.mode,
          steps: args.steps,
          trigger_word: args.trigger_word ?? null,
          validation_prompts: args.validation_prompts ?? [],
          validation_images: args.validation_images ?? [],
          enable_gradient_checkpointing: !!args.enable_gradient_checkpointing,
          load_text_encoder_in_8bit: !!args.load_text_encoder_in_8bit,
          expandable_segments: !!args.expandable_segments,
          audio: args.audio,
          clip_count: args.clip_count,
          buckets: args.buckets,
          raw_config_yaml: null,
        },
      });
    },
    [],
  );

  const resetTraining = useCallback(
    async (pod_id: string, project: string) => {
      const ak = apiKeyRef.current;
      if (!ak) return;
      try {
        await invoke("reset_training", {
          apiKey: ak,
          podId: pod_id,
          projectName: project,
        });
      } catch {
        /* ignore */
      }
      const key = `${pod_id}:${project}`;
      trainingStatesRef.current.delete(key);
      validationsNotifiedRef.current.delete(key);
      setTrainingStates(new Map(trainingStatesRef.current));
      clearLog(trainKey(pod_id, project));
      tick();
    },
    [tick],
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
  const takeTestResult = useCallback((pod_id: string, project: string) => {
    const k = testCaptionKey(pod_id, project);
    const r = testResultsRef.current.get(k) ?? null;
    if (r) testResultsRef.current.delete(k);
    return r;
  }, []);

  const api: TasksApi = {
    apiKey,
    hfToken,
    geminiKey,
    reloadSecrets,
    notificationsEnabled,
    setNotificationsEnabled,
    pods,
    managed,
    reloadPods,
    setManaged,
    sshProbes,
    nvidia,
    projectList,
    projects,
    reloadProjectList,
    loadProjectByName,
    saveProject,
    localTools,
    installing,
    reloadLocalTools,
    installFfmpeg,
    installRunpodctl,
    tasks,
    byPod,
    builds,
    initStates,
    captionStatuses,
    trainingStates,
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
    startTraining,
    exportTrainingConfig,
    resetTraining,
  };

  return <TasksContext.Provider value={api}>{children}</TasksContext.Provider>;
}

function taskKey(t: PodTask): string {
  return `${t.kind}:${t.pod_id ?? ""}:${t.project_name ?? ""}`;
}

function fireNotify(
  task: PodTask,
  t: (k: string) => string,
  outcome: "done" | "failed",
  notify: (title: string, body: string) => void,
) {
  const titles: Record<TaskKind, [string, string]> = {
    init: [t("notify.init_done"), t("notify.init_failed")],
    caption: [t("notify.caption_done"), t("notify.caption_failed")],
    upload: [t("notify.upload_done"), t("notify.upload_failed")],
    build: [t("notify.build_done"), t("notify.build_failed")],
    test_caption: [t("notify.test_done"), t("notify.test_failed")],
    train: [t("notify.train_done"), t("notify.train_failed")],
  };
  const [okT, errT] = titles[task.kind];
  const body = [
    task.project_name ?? "",
    task.pod_name && task.pod_name !== task.pod_id ? task.pod_name : task.pod_id ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
  notify(outcome === "done" ? okT : errT, body);
}
