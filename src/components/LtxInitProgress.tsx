import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import XTermPanel, { XTermHandle } from "./XTerm";
import { initStepKey, useTasks } from "../lib/tasks";
import { ProgressKind, parseProgress } from "../lib/progress";

const STEPS = ["packages", "env", "model", "encoder", "verify"] as const;
type StepId = (typeof STEPS)[number];
type StepState = "pending" | "running" | "done" | "failed";

interface StepStatus {
  state: StepState;
  exit_code: number | null;
  log_size: number;
}

interface InitState {
  tmux_available: boolean;
  steps: Record<string, StepStatus>;
}

const POLL_RUNNING_MS = 2000;
const POLL_IDLE_MS = 5000;

export default function LtxInitProgress({
  apiKey,
  podId,
  hfToken,
  onComplete,
}: {
  apiKey: string;
  podId: string;
  hfToken: string;
  onComplete: () => void;
}) {
  const { t } = useTranslation();

  const [steps, setSteps] = useState<Record<StepId, StepStatus>>(() =>
    Object.fromEntries(
      STEPS.map((s) => [s, { state: "pending", exit_code: null, log_size: 0 }]),
    ) as Record<StepId, StepStatus>,
  );
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [completedReported, setCompletedReported] = useState(false);

  const termRef = useRef<XTermHandle>(null);
  const tailPosRef = useRef<Record<StepId, number>>({
    packages: 0,
    env: 0,
    model: 0,
    encoder: 0,
    verify: 0,
  });
  const activeStepRef = useRef<StepId | null>(null);
  const startedStepsRef = useRef<Set<StepId>>(new Set());
  const apiKeyRef = useRef(apiKey);
  const hfTokenRef = useRef(hfToken);
  const podIdRef = useRef(podId);

  useEffect(() => {
    apiKeyRef.current = apiKey;
  }, [apiKey]);
  useEffect(() => {
    hfTokenRef.current = hfToken;
  }, [hfToken]);
  useEffect(() => {
    podIdRef.current = podId;
  }, [podId]);

  // Активный шаг = первый running, или первый pending после всех done.
  const activeStep = useMemo<StepId | null>(() => {
    for (const s of STEPS) {
      if (steps[s].state === "running") return s;
    }
    for (const s of STEPS) {
      if (steps[s].state !== "done") return s;
    }
    return STEPS[STEPS.length - 1];
  }, [steps]);

  const tasks = useTasks();

  // Терминал тянет лог из глобального буфера TasksProvider — переживает
  // переключение вкладок и не ждёт SSH-затягивания при возврате.
  useEffect(() => {
    if (!activeStep) return;
    const term = termRef.current;
    if (!term) return;
    const key = initStepKey(podIdRef.current, activeStep);
    term.reset();
    const initial = tasks.getLog(key);
    if (initial) {
      term.write(initial);
      // первичный прогресс
      const p = parseProgress(`init_${activeStep}` as ProgressKind, initial);
      setProgress(p);
    }
    const unsub = tasks.subscribeLog(key, (chunk) => {
      if (chunk === "\x1b[2J\x1b[H") {
        term.reset();
      } else {
        term.write(chunk);
      }
      const p = parseProgress(
        `init_${activeStep}` as ProgressKind,
        tasks.getLog(key),
      );
      setProgress(p);
    });
    activeStepRef.current = activeStep;
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStep, podId]);

  async function fetchState(): Promise<InitState | null> {
    try {
      const s = await invoke<InitState>("check_init_state", {
        apiKey: apiKeyRef.current,
        podId: podIdRef.current,
      });
      const next = { ...steps };
      for (const id of STEPS) {
        if (s.steps[id]) {
          next[id] = s.steps[id];
        }
      }
      setSteps(next);
      return s;
    } catch (e: any) {
      setError(String(e));
      return null;
    }
  }

  // прогресс активного шага — парсится в subscribeLog колбэке
  const [progress, setProgress] = useState<{ pct: number; label: string } | null>(null);

  async function startStep(step: StepId) {
    if (startedStepsRef.current.has(step)) return;
    startedStepsRef.current.add(step);
    try {
      await invoke("start_init_step", {
        args: {
          api_key: apiKeyRef.current,
          pod_id: podIdRef.current,
          step,
          hf_token: hfTokenRef.current,
        },
      });
    } catch (e: any) {
      startedStepsRef.current.delete(step);
      setError(String(e));
    }
  }

  // Главный цикл: каждые N мс — состояние + хвост активного лога. Запускаем
  // следующие шаги по мере завершения предыдущих.
  useEffect(() => {
    let stopped = false;

    async function tick() {
      if (stopped) return;
      const s = await fetchState();
      if (stopped || !s) return;

      // продвижение конвейера
      let advanced = false;
      let allDone = true;
      let anyFailed = false;
      for (const id of STEPS) {
        const st = s.steps[id]?.state ?? "pending";
        if (st === "failed") {
          anyFailed = true;
          allDone = false;
          break;
        }
        if (st !== "done") {
          allDone = false;
        }
        if (st === "pending" && started && !advanced) {
          // запускаем только если все предыдущие done
          const idx = STEPS.indexOf(id);
          const prevAllDone = STEPS.slice(0, idx).every(
            (p) => s.steps[p]?.state === "done",
          );
          if (prevAllDone) {
            advanced = true;
            await startStep(id);
            // быстро дёрнем состояние, чтоб running появился
            setTimeout(() => {
              if (!stopped) fetchState();
            }, 700);
          }
          break; // дальше pending не трогаем
        }
        if (st === "running") {
          // лог тянет TasksProvider в фоне; здесь только выходим.
          break;
        }
      }

      if (allDone && !completedReported) {
        setCompletedReported(true);
        onComplete();
      }
      if (anyFailed) {
        // ничего автоматического — пользователь должен ткнуть Retry
      }
    }

    // первый прогон сразу
    tick();
    const period =
      Object.values(steps).some((x) => x.state === "running") ||
      started
        ? POLL_RUNNING_MS
        : POLL_IDLE_MS;
    const id = window.setInterval(tick, period);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  const anyFailed = useMemo(
    () => STEPS.some((s) => steps[s].state === "failed"),
    [steps],
  );
  const anyRunning = useMemo(
    () => STEPS.some((s) => steps[s].state === "running"),
    [steps],
  );

  async function start() {
    setError(null);
    setStarted(true);
    // если что-то failed — сбросим этот шаг и все после него
    if (anyFailed) {
      const failedIdx = STEPS.findIndex((s) => steps[s].state === "failed");
      if (failedIdx >= 0) {
        for (let i = failedIdx; i < STEPS.length; i++) {
          try {
            await invoke("reset_init_step", {
              apiKey: apiKeyRef.current,
              podId: podIdRef.current,
              step: STEPS[i],
            });
          } catch {
            /* ignore */
          }
        }
      }
      startedStepsRef.current = new Set();
      // сброс локального view
      const next = { ...steps };
      for (let i = failedIdx; i < STEPS.length; i++) {
        next[STEPS[i]] = { state: "pending", exit_code: null, log_size: 0 };
        tailPosRef.current[STEPS[i]] = 0;
      }
      setSteps(next);
    }
    await fetchState();
  }

  const showTerminal = STEPS.some(
    (s) => steps[s].state !== "pending" || started,
  );

  return (
    <div className="space-y-4">
      <ol className="space-y-1.5">
        {STEPS.map((s) => {
          const st = steps[s].state;
          const isActive = s === activeStep && st === "running";
          const fillPct = isActive && progress ? Math.max(0, Math.min(100, progress.pct)) : 0;
          return (
            <li
              key={s}
              className={
                "relative overflow-hidden rounded-lg border px-3 py-2 transition flex items-center gap-3 " +
                (st === "running"
                  ? "border-blue-500/40 bg-blue-500/5"
                  : st === "done"
                  ? "border-green-500/30 bg-green-500/5"
                  : st === "failed"
                  ? "border-red-500/40 bg-red-500/5"
                  : "border-black/[0.06] dark:border-white/[0.1]")
              }
            >
              {/* живая заливка фона по прогрессу для активного шага */}
              {isActive && fillPct > 0 && (
                <div
                  className="absolute inset-y-0 left-0 bg-blue-500/15 transition-[width] pointer-events-none"
                  style={{ width: `${fillPct}%` }}
                />
              )}
              <div className="relative flex items-center gap-3 w-full">
                <Icon state={st} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{t(`init.step_${s}`)}</div>
                </div>
                <div className="text-[11px] text-neutral-500">
                  {t(`init.eta_${s}`)}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {showTerminal && (
        <div className="rounded-xl overflow-hidden border border-black/[0.08] dark:border-white/[0.08] shadow-inner">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-black/40 border-b border-white/5">
            <span
              className={`w-2 h-2 rounded-full ${dotColor(activeStep ? steps[activeStep].state : "pending")}`}
            />
            <span className="text-[11px] text-neutral-400 truncate font-mono">
              {activeStep ? `tmux: ltx_${activeStep}` : "—"}
            </span>
          </div>
          <XTermPanel ref={termRef} />
        </div>
      )}

      {error && (
        <div className="text-xs text-red-500">
          <div className="font-mono whitespace-pre-wrap">{error}</div>
        </div>
      )}
      <div className="flex items-center gap-3">
        {!anyRunning && (
          <button
            onClick={start}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-500 hover:bg-blue-600 text-white shadow-sm"
          >
            {anyFailed ? "↻ " + t("common.retry") : t("detail.setup_start")}
          </button>
        )}
        {anyRunning && (
          <p className="text-xs text-neutral-500">{t("init.in_progress")}</p>
        )}
      </div>
    </div>
  );
}

function dotColor(state: StepState) {
  switch (state) {
    case "running":
      return "bg-blue-500 animate-pulse";
    case "done":
      return "bg-green-500";
    case "failed":
      return "bg-red-500";
    default:
      return "bg-neutral-400";
  }
}

function Icon({ state }: { state: StepState }) {
  if (state === "done")
    return (
      <span className="w-6 h-6 inline-flex items-center justify-center rounded-full bg-green-500/20 text-green-600 dark:text-green-400 text-xs">
        ✓
      </span>
    );
  if (state === "failed")
    return (
      <span className="w-6 h-6 inline-flex items-center justify-center rounded-full bg-red-500/20 text-red-500 text-xs">
        ✕
      </span>
    );
  if (state === "running")
    return (
      <span className="w-6 h-6 inline-flex items-center justify-center rounded-full bg-blue-500/20 text-blue-500">
        <span className="block w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse" />
      </span>
    );
  return (
    <span className="w-6 h-6 inline-flex items-center justify-center rounded-full bg-black/5 dark:bg-white/10 text-neutral-500 text-xs">
      ○
    </span>
  );
}

