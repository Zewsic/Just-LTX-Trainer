import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Banner,
  Button,
  Card,
  Mono,
  Pill,
  ProgressBar,
  Spinner,
  Toggle,
} from "../components/ui";
import CreateServer, { GpuType } from "../components/CreateServer";
import { ManagedPod, Pod, podPhase } from "../lib/pods";
import {
  BuildState,
  PodTask,
  useLiveProgress,
  useTasks,
} from "../lib/tasks";

export default function Servers({
  onOpen,
  onOpenSettings,
  onOpenTraining,
}: {
  onOpen: (id: string) => void;
  onOpenSettings: () => void;
  onOpenTraining: (project: string, pod: string) => void;
}) {
  const { t } = useTranslation();
  const tasks = useTasks();
  const [filter, setFilter] = useState<"mine" | "all">("mine");
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const apiKey = tasks.apiKey;
  const managed = tasks.managed;
  const livePods = tasks.pods;

  const visible = useMemo(() => {
    if (livePods.size === 0 && managed.length === 0) return null;
    const all: Pod[] = Array.from(livePods.values());
    return filter === "mine"
      ? all.filter((p) => managed.some((m) => m.id === p.id))
      : all;
  }, [livePods, managed, filter]);

  // detect API errors (probe failures aren't here — just list_pods generic)
  useEffect(() => {
    setError(null);
  }, [apiKey]);

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

  async function onCreated(res: { id: string; name: string }, gpu: GpuType) {
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
    await tasks.setManaged(next);
    setCreateOpen(false);
    await tasks.reloadPods();
    onOpen(res.id);
  }

  // active builds — banners on top
  const activeBuilds = Array.from(tasks.builds.values()).filter(
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
          <Toggle<"mine" | "all">
            size="sm"
            value={filter}
            onChange={setFilter}
            items={[
              { id: "mine", label: t("servers.filter.mine") },
              { id: "all", label: t("servers.filter.all") },
            ]}
          />
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
              <Button onClick={() => setCreateOpen(true)}>
                ＋ {t("servers.create")}
              </Button>
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
                  onOpenTraining={onOpenTraining}
                />
              );
            })}
          </ul>
        )}
        {visible && visible.length > 0 && (
          <div className="mt-5 flex justify-end">
            <Button onClick={() => setCreateOpen(true)}>
              ＋ {t("servers.create")}
            </Button>
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
  onOpenTraining,
}: {
  live: Pod;
  managed: ManagedPod | null;
  onOpen: () => void;
  onOpenTraining: (project: string, pod: string) => void;
}) {
  const { t } = useTranslation();
  const tasks = useTasks();
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
  const podTasks = tasks.byPod.get(live.id) ?? [];

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
      <ProgressBar
        variant="fill"
        pct={fillPct}
        tone="info"
        className="hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition"
      >
        <button
          onClick={onOpen}
          className="w-full px-5 py-3.5 flex items-center gap-4 text-left"
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium truncate">{live.name || live.id}</span>
              {activeTask ? (
                <TaskBadge
                  task={activeTask}
                  liveProgress={liveProgress}
                  onOpenTraining={onOpenTraining}
                />
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
          <span className="text-neutral-400">›</span>
        </button>
      </ProgressBar>
    </li>
  );
}

function TaskBadge({
  task,
  liveProgress,
  onOpenTraining,
}: {
  task: PodTask;
  liveProgress?: { pct: number; label: string } | null;
  onOpenTraining: (project: string, pod: string) => void;
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

  // Бейдж train кликабелен — переход в Training с этим проектом+подом.
  // Остальные пока ловятся обычным row-click (открывает ServerDetail).
  const clickable =
    task.kind === "train" &&
    !!task.project_name &&
    !!task.pod_id &&
    task.state === "running";

  const inner = (
    <>
      {task.state === "failed" ? "✕ " : <Spinner className="w-3 h-3" />}
      {" "}
      {title}
      {pct}
    </>
  );

  if (!clickable) {
    return (
      <Pill tone={task.state === "failed" ? "err" : "info"}>{inner}</Pill>
    );
  }
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onOpenTraining(task.project_name!, task.pod_id!);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onOpenTraining(task.project_name!, task.pod_id!);
        }
      }}
      className="cursor-pointer hover:opacity-80 transition"
    >
      <Pill tone="info">{inner}</Pill>
    </span>
  );
}

function BuildBanner({ state }: { state: BuildState }) {
  const { t } = useTranslation();
  const totalVideos = state.videos_total ?? 0;
  const doneVideos = state.videos_done;
  const pct =
    totalVideos > 0
      ? (doneVideos / totalVideos) * 100
      : state.status === "zipping"
      ? 100
      : 0;
  const subtitle =
    state.status === "zipping"
      ? t("ds.prep.build_zipping")
      : totalVideos > 0
      ? `${doneVideos}/${totalVideos} · ${state.done_clips}/${state.total_clips || "?"}`
      : t("ds.prep.build_running");
  return (
    <Banner
      tone="info"
      pct={pct}
      title={`${t("ds.prep.build")} · ${state.project}`}
      subtitle={subtitle}
    />
  );
}
