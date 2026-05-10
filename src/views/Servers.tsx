import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Button, Card, Mono, Pill, Spinner } from "../components/ui";
import CreateServer, { GpuType } from "../components/CreateServer";
import {
  loadManaged,
  ManagedPod,
  Pod,
  podPhase,
  saveManaged,
  store,
} from "../lib/pods";
import { BuildState, PodTask, useLiveProgress, useTasks } from "../lib/tasks";

const POLL_MS = 10_000;

export default function Servers({
  onOpen,
  onOpenSettings,
}: {
  onOpen: (id: string) => void;
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [pods, setPods] = useState<Pod[] | null>(null);
  const [managed, setManaged] = useState<ManagedPod[]>([]);
  const [filter, setFilter] = useState<"mine" | "all">("mine");
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const apiKeyRef = useRef<string | null>(null);

  async function load() {
    const k = (await store.get<string>("runpod_key")) ?? "";
    setApiKey(k || null);
    apiKeyRef.current = k || null;
    setManaged(await loadManaged());
    if (k) await refresh(k);
  }

  async function refresh(key: string) {
    try {
      setError(null);
      const list = await invoke<Pod[]>("list_pods", { apiKey: key });
      setPods(list);
    } catch (e: any) {
      setError(String(e));
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      if (apiKeyRef.current) refresh(apiKeyRef.current);
    }, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const visible = useMemo(() => {
    if (!pods) return null;
    return filter === "mine"
      ? pods.filter((p) => managed.some((m) => m.id === p.id))
      : pods;
  }, [pods, managed, filter]);

  if (!apiKey) {
    return (
      <Card>
        <div className="py-10 text-center space-y-3">
          <h2 className="text-base font-semibold">{t("servers.no_key_title")}</h2>
          <p className="text-sm text-neutral-500 max-w-sm mx-auto">
            {t("servers.no_key_hint")}
          </p>
          <div className="pt-2">
            <Button onClick={onOpenSettings}>{t("servers.open_settings")}</Button>
          </div>
        </div>
      </Card>
    );
  }

  async function onCreated(
    res: { id: string; name: string },
    gpu: GpuType,
  ) {
    const next: ManagedPod[] = [
      {
        id: res.id,
        name: res.name,
        ltx_state: "init",
        created_at: Date.now(),
        gpu_type_id: gpu.id,
      },
      ...managed,
    ];
    setManaged(next);
    await saveManaged(next);
    setCreateOpen(false);
    if (apiKeyRef.current) await refresh(apiKeyRef.current);
    onOpen(res.id);
  }

  const activeBuilds = Array.from((useTasks().builds as Map<string, BuildState>).values()).filter(
    (b) => b.status === "running" || b.status === "zipping",
  );

  return (
    <div className="space-y-4">
      {activeBuilds.map((b) => (
        <BuildBanner key={b.project} state={b} />
      ))}
      <Card
        title={t("servers.title")}
        action={
          <div className="inline-flex rounded-lg bg-black/[0.05] dark:bg-white/[0.06] p-0.5 text-xs">
            {(["mine", "all"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={
                  "px-3 py-1.5 rounded-md transition " +
                  (filter === f
                    ? "bg-white dark:bg-white/[0.12] shadow-sm font-medium"
                    : "text-neutral-500 hover:text-current")
                }
              >
                {t(`servers.filter.${f}`)}
              </button>
            ))}
          </div>
        }
      >
        {error && (
          <div className="mb-4">
            <Mono>{error}</Mono>
          </div>
        )}
        {visible === null ? (
          <div className="py-10 flex justify-center text-neutral-500">
            <Spinner />
          </div>
        ) : visible.length === 0 ? (
          <div className="py-10 text-center space-y-2">
            <h2 className="text-sm font-semibold">{t("servers.empty_title")}</h2>
            <p className="text-xs text-neutral-500 max-w-xs mx-auto">
              {t("servers.empty_hint")}
            </p>
            <div className="pt-3">
              <Button onClick={() => setCreateOpen(true)}>＋ {t("servers.create")}</Button>
            </div>
          </div>
        ) : (
          <ul className="-mx-5 divide-y divide-black/[0.05] dark:divide-white/[0.07]">
            {visible.map((p) => {
              const m = managed.find((x) => x.id === p.id) ?? null;
              return (
                <PodRow
                  key={p.id}
                  live={p}
                  managed={m}
                  onOpen={() => onOpen(p.id)}
                />
              );
            })}
          </ul>
        )}
        {visible && visible.length > 0 && (
          <div className="mt-5 flex justify-end">
            <Button onClick={() => setCreateOpen(true)}>＋ {t("servers.create")}</Button>
          </div>
        )}
      </Card>

      <CreateServer
        open={createOpen}
        apiKey={apiKey}
        onClose={() => setCreateOpen(false)}
        onCreated={onCreated}
      />
    </div>
  );
}

function PodRow({
  live,
  managed,
  onOpen,
}: {
  live: Pod;
  managed: ManagedPod | null;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const phase = podPhase(live, managed);

  const phaseUI: Record<typeof phase, { tone: any; label: string; icon?: React.ReactNode }> = {
    provisioning: {
      tone: "warn",
      label: t("servers.row_provisioning"),
      icon: <Spinner className="w-3 h-3" />,
    },
    needs_setup: { tone: "info", label: t("servers.row_setting_up") },
    ready: { tone: "ok", label: t("servers.row_ready") },
    running: { tone: "ok", label: t("servers.row_running") },
    stopped: { tone: "neutral", label: t("servers.row_stopped") },
    unknown: { tone: "neutral", label: t("servers.row_unknown") },
  };
  const ui = phaseUI[phase];
  const { byPod } = useTasks();
  const podTasks = byPod.get(live.id) ?? [];

  const runningTask = podTasks.find((t) => t.state === "running");
  const failedTask = podTasks.find((t) => t.state === "failed");
  const activeTask = runningTask ?? failedTask;
  const liveProgress = useLiveProgress(
    runningTask?.log_key,
    runningTask?.progress_kind,
    runningTask?.progress != null
      ? { pct: runningTask.progress, label: runningTask.progress_label ?? "" }
      : null,
  );
  const fillPct = liveProgress?.pct ?? runningTask?.progress ?? 0;

  return (
    <li>
      <button
        onClick={onOpen}
        className="relative overflow-hidden w-full px-5 py-3.5 flex items-center gap-4 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition"
      >
        {/* Фон-заливка прогресса для активной задачи */}
        {fillPct > 0 && (
          <div
            className="absolute inset-y-0 left-0 bg-blue-500/10 transition-[width] pointer-events-none"
            style={{ width: `${Math.max(0, Math.min(100, fillPct))}%` }}
          />
        )}
        <div className="relative flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium truncate">{live.name || live.id}</span>
            {activeTask ? (
              <TaskBadge task={activeTask} liveProgress={liveProgress} />
            ) : (
              <Pill tone={ui.tone}>
                {ui.icon}
                {ui.label}
              </Pill>
            )}
          </div>
          <div className="text-xs text-neutral-500 mt-0.5 truncate">
            {live.gpu_display_name ?? "—"}
            {live.gpu_count ? ` × ${live.gpu_count}` : ""}
            {live.cost_per_hr != null
              ? ` · $${live.cost_per_hr.toFixed(3)}/hr`
              : ""}
          </div>
        </div>
        <span className="relative text-neutral-400">›</span>
      </button>
    </li>
  );
}

function TaskBadge({
  task,
  liveProgress,
}: {
  task: PodTask;
  liveProgress?: { pct: number; label: string } | null;
}) {
  const { t } = useTranslation();
  let title: string;
  switch (task.kind) {
    case "init":
      title = t("servers.task_init", {
        idx: task.step_index ?? 1,
        total: task.step_total ?? 5,
      });
      break;
    case "caption":
      title = t("servers.task_caption", { project: task.project_name ?? "" });
      break;
    case "upload":
      title = t("servers.task_upload", { project: task.project_name ?? "" });
      break;
    case "build":
      title = t("servers.task_build", { project: task.project_name ?? "" });
      break;
    case "test_caption":
      title = t("servers.task_test", { project: task.project_name ?? "" });
      break;
    default:
      title = task.label;
  }
  const livePct = liveProgress?.pct ?? task.progress;
  const pct = typeof livePct === "number" ? `: ${livePct.toFixed(0)}%` : "";
  if (task.state === "failed") {
    return <Pill tone="err">✕ {title}</Pill>;
  }
  return (
    <Pill tone="info">
      <Spinner className="w-3 h-3" /> {title}
      {pct}
    </Pill>
  );
}

function BuildBanner({ state }: { state: BuildState }) {
  const totalVideos = state.videos_total ?? 0;
  const doneVideos = state.videos_done;
  const pct =
    totalVideos > 0
      ? (doneVideos / totalVideos) * 100
      : state.status === "zipping"
      ? 100
      : 0;
  return (
    <div className="rounded-2xl border border-blue-500/30 bg-blue-500/5 px-5 py-3.5 relative overflow-hidden">
      <div
        className="absolute inset-y-0 left-0 bg-blue-500/10 transition-[width] pointer-events-none"
        style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
      />
      <div className="relative flex items-center gap-3">
        <Spinner />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">
            Build · {state.project}
          </div>
          <div className="text-xs text-neutral-500">
            {state.status === "zipping"
              ? "packing zip…"
              : totalVideos > 0
              ? `${doneVideos}/${totalVideos} videos · ${state.done_clips}/${state.total_clips || "?"} clips`
              : "preparing…"}
          </div>
        </div>
        <span className="font-mono text-sm tabular-nums">
          {pct.toFixed(0)}%
        </span>
      </div>
    </div>
  );
}
