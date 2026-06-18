import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Card,
  Mono,
  Pill,
  ProgressBar,
  Spinner,
  StatusIcon,
} from "../../components/ui";
import XTermPanel, { XTermHandle } from "../../components/XTerm";
import { GpuStats } from "../../components/GpuStat";
import {
  trainKey,
  TrainingState,
  useNvidia,
  useTasks,
} from "../../lib/tasks";
import { Project } from "../../lib/projects";
import ValidationBlock from "./ValidationBlock";

type TaskId = "prep" | "preprocess" | "vram_clear" | "train" | "validate";
type TaskStatus = "pending" | "running" | "done" | "failed";

const TASKS: TaskId[] = ["prep", "preprocess", "vram_clear", "train", "validate"];

export default function TrainingActive({
  project,
  apiKey,
  podId,
  state,
  totalClips,
  onBack,
}: {
  project: Project;
  apiKey: string;
  podId: string;
  state: TrainingState;
  totalClips: number;
  onBack: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const tasks = useTasks();
  const nvidia = useNvidia(podId);

  const cfg = project.training;
  const trigger = (cfg.trigger_word ?? "").trim();

  const taskStatus = useMemo<Record<TaskId, TaskStatus>>(() => {
    return computeTaskStatuses(state);
  }, [state]);

  // Top-bar показывает прогресс активной фазы:
  //   train  → step / total_steps
  //   preprocess → preprocess_progress.done / total
  //   done   → 100%
  const overallPct = (() => {
    if (state.state === "done") return 100;
    if (state.phase === "train" && state.total_steps && state.total_steps > 0) {
      return ((state.step ?? 0) / state.total_steps) * 100;
    }
    if (
      state.phase === "preprocess" &&
      state.preprocess_progress &&
      state.preprocess_progress.total > 0
    ) {
      return (
        (state.preprocess_progress.done / state.preprocess_progress.total) * 100
      );
    }
    return 0;
  })();

  // Терминал. Rich-логгер LTX-2 (process_dataset.py / process_captions.py)
  // приклеивает к INFO-строкам `<имя_файла>.py:NNN`. Чистим визуально,
  // не трогая лог-буфер. Регулярка требует, чтобы сразу за `.py:N` шёл
  // `\r?\n` — иначе не трогает (это важно для tqdm/rich-прогрессбаров,
  // которые приходят по `\r` без `\n`: их нельзя задерживать в буфере).
  const termRef = useRef<XTermHandle>(null);
  const logKey = trainKey(podId, project.name);
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.reset();
    const RICH_SUFFIX = /[ \t]{5,}[A-Za-z0-9_./-]+\.py:\d+[ \t]*(?=\r?\n)/g;
    const clean = (s: string) => s.replace(RICH_SUFFIX, "");
    const init = tasks.getLog(logKey);
    if (init) term.write(clean(init));
    const unsub = tasks.subscribeLog(logKey, (chunk) => {
      if (chunk === "\x1b[2J\x1b[H") {
        term.reset();
        return;
      }
      term.write(clean(chunk));
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logKey]);

  const isRunning = state.state === "running";
  const headlineTone =
    state.state === "failed"
      ? "err"
      : state.state === "done"
      ? "ok"
      : "info";

  // Финальный заголовок зависит от состояния.
  const headlineLabel = isRunning
    ? null
    : state.state === "done"
    ? t("tr.active.headline_done")
    : state.state === "failed"
    ? t("tr.active.headline_failed")
    : null;
  const headlineIcon = isRunning
    ? null
    : state.state === "done"
    ? "✓"
    : state.state === "failed"
    ? "✕"
    : null;

  return (
    <>
      {!isRunning && headlineLabel && (
        <Card>
          <div className="flex items-center gap-3">
            <span
              className={
                "w-9 h-9 rounded-full inline-flex items-center justify-center text-lg shrink-0 " +
                (state.state === "done"
                  ? "bg-green-500/15 text-green-600 dark:text-green-400"
                  : "bg-red-500/15 text-red-500")
              }
            >
              {headlineIcon}
            </span>
            <div className="flex-1 min-w-0">
              <div
                className={
                  "text-sm font-semibold " +
                  (state.state === "done"
                    ? "text-green-600 dark:text-green-400"
                    : "text-red-500")
                }
              >
                {headlineLabel}
              </div>
              {state.state === "failed" && (
                <div className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
                  {t(
                    `tr.active.err_${state.error_kind ?? "other"}`,
                    t("tr.active.err_other"),
                  )}
                </div>
              )}
            </div>
            <Button onClick={onBack}>{t("tr.active.back")}</Button>
          </div>
        </Card>
      )}

      <Card>
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold mb-2">
              {t("tr.active.summary")}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-1.5 text-xs">
              <SumRow k={t("tr.active.rank")} v={cfg.rank ?? "—"} mono />
              <SumRow k={t("tr.active.steps")} v={(cfg.steps ?? 0).toLocaleString()} mono />
              <SumRow k={t("tr.active.mode")} v={cfg.mode ?? "—"} mono />
              {trigger && (
                <SumRow
                  k={t("tr.active.trigger")}
                  v={
                    <span className="px-1.5 py-0.5 rounded-md bg-blue-500/15 text-blue-700 dark:text-blue-300 font-mono text-[11px]">
                      {trigger}
                    </span>
                  }
                />
              )}
              <SumRow k={t("tr.active.clips")} v={totalClips.toString()} mono />
              <SumRow
                k={t("tr.flags.label")}
                v={
                  <span className="inline-flex gap-1">
                    {cfg.enable_gradient_checkpointing && (
                      <Pill tone="info">grad ✓</Pill>
                    )}
                    {cfg.load_text_encoder_in_8bit && <Pill tone="info">8-bit ✓</Pill>}
                    {!cfg.enable_gradient_checkpointing &&
                      !cfg.load_text_encoder_in_8bit && (
                        <span className="text-neutral-500">—</span>
                      )}
                  </span>
                }
              />
            </div>
          </div>
        </div>
      </Card>

      <Card title={t("tr.active.title")}>
        <ProgressBar
          pct={overallPct}
          tone={headlineTone}
          label={
            <span className="inline-flex items-center gap-1.5">
              <Spinner /> {t("tr.active.tasks")}
              {state.eta && (
                <span className="text-[11px] font-mono text-neutral-500">
                  · ETA {state.eta}
                </span>
              )}
              {typeof state.loss === "number" && (
                <span className="text-[11px] font-mono text-neutral-500">
                  · loss {state.loss.toFixed(4)}
                </span>
              )}
              {state.step_time && (
                <span className="text-[11px] font-mono text-neutral-500">
                  · {state.step_time}
                </span>
              )}
            </span>
          }
          value={
            state.phase === "train" && state.total_steps
              ? `${(state.step ?? 0).toLocaleString()}/${state.total_steps.toLocaleString()} · ${overallPct.toFixed(0)}%`
              : state.phase === "preprocess" && state.preprocess_progress
              ? `${state.preprocess_progress.kind} ${state.preprocess_progress.done}/${state.preprocess_progress.total} · ${overallPct.toFixed(0)}%`
              : null
          }
          className="mb-4"
        />
        <ul className="space-y-1.5 mb-4">
          {TASKS.map((id) => (
            <TaskRow
              key={id}
              id={id}
              status={taskStatus[id]}
              state={state}
            />
          ))}
        </ul>

        {state.state === "failed" && state.error && (
          <div className="mb-4">
            <Mono>{state.error}</Mono>
          </div>
        )}

        <div className="rounded-xl overflow-hidden border border-black/[0.08] dark:border-white/[0.08] mb-4">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-black/40 border-b border-white/5">
            <span
              className={
                "w-2 h-2 rounded-full " +
                (isRunning
                  ? "bg-blue-500 animate-pulse"
                  : state.state === "done"
                  ? "bg-green-500"
                  : state.state === "failed"
                  ? "bg-red-500"
                  : "bg-neutral-400")
              }
            />
            <span className="text-[11px] text-neutral-400 font-mono">
              tmux: ltx_train_{project.name}
            </span>
          </div>
          <XTermPanel ref={termRef} />
        </div>

        {(isRunning || nvidia) && (
          <GpuStats nvidia={nvidia} loadingLabel="nvidia-smi…" />
        )}
      </Card>

      <ValidationBlock
        apiKey={apiKey}
        podId={podId}
        projectName={project.name}
        completedSteps={state.validations_done ?? []}
        prompts={cfg.validation_prompts ?? []}
        trigger={trigger}
      />
    </>
  );
}

function computeTaskStatuses(state: TrainingState): Record<TaskId, TaskStatus> {
  const phase = state.phase ?? null;
  const failed = state.state === "failed";
  const done = state.state === "done";

  // Линейный порядок до train, плюс validate как параллельный с train.
  const order: TaskId[] = ["prep", "preprocess", "vram_clear", "train"];
  const phaseIdx = order.indexOf((phase as TaskId) ?? ("prep" as TaskId));

  const out: Record<TaskId, TaskStatus> = {
    prep: "pending",
    preprocess: "pending",
    vram_clear: "pending",
    train: "pending",
    validate: "pending",
  };

  if (done) {
    for (const k of order) out[k] = "done";
    out.validate =
      (state.validations_done ?? []).length > 0 ? "done" : "pending";
    return out;
  }

  for (let i = 0; i < order.length; i++) {
    if (i < phaseIdx) out[order[i]] = "done";
    else if (i === phaseIdx) out[order[i]] = failed ? "failed" : "running";
  }

  // validate — running, если активна валидация в этот тик; done, если есть
  // хотя бы один завершённый чекпоинт.
  if (state.validation_progress != null || state.current_validation != null) {
    out.validate = "running";
  } else if ((state.validations_done ?? []).length > 0) {
    out.validate = "done";
  }

  return out;
}

function TaskRow({
  id,
  status,
  state,
}: {
  id: TaskId;
  status: TaskStatus;
  state: TrainingState;
}) {
  const { t } = useTranslation();
  const tone =
    status === "failed"
      ? "err"
      : status === "done"
      ? "ok"
      : status === "running"
      ? "info"
      : "neutral";

  // Прогресс-заливка для активной фазы.
  let pct = 0;
  if (status === "running") {
    if (id === "train" && state.total_steps && state.total_steps > 0) {
      pct = ((state.step ?? 0) / state.total_steps) * 100;
    } else if (
      id === "preprocess" &&
      state.preprocess_progress &&
      state.preprocess_progress.total > 0
    ) {
      pct =
        (state.preprocess_progress.done / state.preprocess_progress.total) *
        100;
    } else if (id === "validate" && state.validation_progress) {
      // Валидация = sample K из M × inference X из Y.
      // Считаем общий прогресс по «инференс-шагам».
      const vp = state.validation_progress;
      if (vp.samples_total > 0 && vp.inf_total > 0) {
        const done = (vp.sample - 1) * vp.inf_total + vp.inf_step;
        const total = vp.samples_total * vp.inf_total;
        pct = (done / total) * 100;
      }
    }
  } else if (status === "done") {
    pct = 100;
  }

  // Подпись справа
  let detail: React.ReactNode = null;
  if (id === "preprocess" && status === "running" && state.preprocess_progress) {
    const pp = state.preprocess_progress;
    detail = (
      <span className="font-mono text-[11px] tabular-nums text-blue-600 dark:text-blue-400">
        {pp.kind} {pp.done}/{pp.total}
      </span>
    );
  } else if (id === "train" && status !== "pending") {
    const valActive =
      state.validation_progress != null || state.current_validation != null;
    if (valActive) {
      detail = (
        <span className="text-[11px] text-amber-600 dark:text-amber-400">
          {t("tr.active.phase_paused")}
        </span>
      );
    } else if (state.total_steps) {
      detail = (
        <span className="font-mono text-[11px] tabular-nums text-neutral-500">
          {(state.step ?? 0).toLocaleString()}/{state.total_steps.toLocaleString()}
        </span>
      );
    }
  } else if (id === "validate") {
    const done = (state.validations_done ?? []).length;
    const vp = state.validation_progress;
    if (vp) {
      detail = (
        <span className="font-mono text-[11px] tabular-nums text-blue-600 dark:text-blue-400">
          {vp.sample}/{vp.samples_total} · {vp.inf_step}/{vp.inf_total}
          {vp.eta && <span className="text-neutral-500"> · ETA {vp.eta}</span>}
        </span>
      );
    } else if (state.current_validation != null) {
      detail = (
        <span className="font-mono text-[11px] tabular-nums text-blue-600 dark:text-blue-400">
          step {state.current_validation}…
        </span>
      );
    } else if (done > 0) {
      detail = (
        <span className="font-mono text-[11px] tabular-nums text-neutral-500">
          ×{done}
        </span>
      );
    }
  }

  return (
    <li>
      <ProgressBar
        variant="fill"
        pct={pct}
        tone={tone}
        className={
          "rounded-lg border px-3 py-2 transition " +
          (status === "running"
            ? "border-blue-500/40"
            : status === "done"
            ? "border-green-500/30"
            : status === "failed"
            ? "border-red-500/40"
            : "border-black/[0.06] dark:border-white/[0.1]")
        }
      >
        <div className="flex items-center gap-3">
          <StatusIcon status={status} />
          <div className="flex-1 min-w-0 text-sm font-medium">
            {t(`tr.active.task_${id}`)}
          </div>
          {detail}
        </div>
      </ProgressBar>
    </li>
  );
}

function SumRow({
  k,
  v,
  mono,
}: {
  k: React.ReactNode;
  v: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-neutral-500">{k}</span>
      <span className={"truncate " + (mono ? "font-mono" : "")}>{v}</span>
    </div>
  );
}
