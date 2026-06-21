import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import XTermPanel, { XTermHandle } from "./XTerm";
import {
  initStepKey,
  InitState,
  InitStepStatus,
  useTasks,
} from "../lib/tasks";
import { ProgressKind, parseProgress } from "../lib/progress";
import { ProgressBar, StatusIcon } from "./ui";

const STEPS = ["packages", "env", "model", "encoder", "verify"] as const;
type StepId = (typeof STEPS)[number];

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
  const tasks = useTasks();

  // Поллинг состояния шагов делает TasksProvider → читаем оттуда.
  const init: InitState | null = tasks.initStates.get(podId) ?? null;
  const stepStatus = (s: StepId): InitStepStatus =>
    init?.steps[s] ?? { state: "pending", log_size: 0 };

  const activeStep = useMemo<StepId | null>(() => {
    for (const s of STEPS) if (stepStatus(s).state === "running") return s;
    for (const s of STEPS) if (stepStatus(s).state !== "done") return s;
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [init]);

  const [error, setError] = useState<string | null>(null);
  // Setup стартует автоматически после создания пода — пользователь не должен
  // жать "Start". Кнопка "Retry" нужна только когда какой-то шаг упал.
  const [started, setStarted] = useState(true);
  const completedRef = useRef(false);
  const startedStepsRef = useRef<Set<StepId>>(new Set());

  const termRef = useRef<XTermHandle>(null);
  const [progress, setProgress] = useState<{ pct: number; label: string } | null>(
    null,
  );

  // Подписка терминала на лог-буфер активного шага.
  useEffect(() => {
    if (!activeStep) {
      setProgress(null);
      return;
    }
    const term = termRef.current;
    if (!term) return;
    const key = initStepKey(podId, activeStep);
    term.reset();
    const initial = tasks.getLog(key);
    if (initial) {
      term.write(initial);
      setProgress(parseProgress(`init_${activeStep}` as ProgressKind, initial));
    }
    const unsub = tasks.subscribeLog(key, (chunk) => {
      if (chunk === "\x1b[2J\x1b[H") term.reset();
      else term.write(chunk);
      setProgress(
        parseProgress(
          `init_${activeStep}` as ProgressKind,
          tasks.getLog(key),
        ),
      );
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStep, podId]);

  // Если все шаги done — отметить под как ready, независимо от того,
  // нажимали ли мы Start в этой сессии. Без этого пользователь, заглянув
  // на страницу после завершения, видит "needs_setup" вечно.
  useEffect(() => {
    if (!init) return;
    const allDone = STEPS.every((s) => stepStatus(s).state === "done");
    if (allDone && !completedRef.current) {
      completedRef.current = true;
      onComplete();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [init]);

  // Авто-старт следующего pending шага. Запускается сразу при монтировании
  // (started=true по дефолту); конвейер дальше ведёт TasksProvider в tick().
  useEffect(() => {
    if (!started || !init) return;
    const anyFailed = STEPS.some((s) => stepStatus(s).state === "failed");
    if (anyFailed) return;
    const anyRunning = STEPS.some((s) => stepStatus(s).state === "running");
    if (anyRunning) return;
    // первый pending — стартуем
    const firstPending = STEPS.find((s) => stepStatus(s).state === "pending");
    if (!firstPending) return;
    if (startedStepsRef.current.has(firstPending)) return;
    startedStepsRef.current.add(firstPending);
    invoke("start_init_step", {
      args: {
        api_key: apiKey,
        pod_id: podId,
        step: firstPending,
        hf_token: hfToken,
      },
    })
      .catch((e) => {
        startedStepsRef.current.delete(firstPending);
        setError(String(e));
      })
      .finally(() => {
        // быстро дёрнем общий рефреш
        tasks.refresh();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, init]);

  const anyFailed = STEPS.some((s) => stepStatus(s).state === "failed");
  const anyRunning = STEPS.some((s) => stepStatus(s).state === "running");

  async function start() {
    setError(null);
    if (anyFailed) {
      const failedIdx = STEPS.findIndex((s) => stepStatus(s).state === "failed");
      if (failedIdx >= 0) {
        for (let i = failedIdx; i < STEPS.length; i++) {
          try {
            await invoke("reset_init_step", {
              apiKey,
              podId,
              step: STEPS[i],
            });
          } catch {
            /* ignore */
          }
        }
      }
      startedStepsRef.current = new Set();
      tasks.refresh();
    }
    setStarted(true);
  }

  const showTerminal =
    started ||
    STEPS.some((s) => {
      const st = stepStatus(s).state;
      return st !== "pending";
    });

  return (
    <div className="space-y-4">
      <ol className="space-y-1.5">
        {STEPS.map((s) => {
          const st = stepStatus(s).state;
          const isActive = s === activeStep && st === "running";
          const fillPct = isActive && progress ? progress.pct : 0;
          const tone =
            st === "failed"
              ? "err"
              : st === "done"
              ? "ok"
              : st === "running"
              ? "info"
              : "neutral";
          return (
            <li key={s}>
              <ProgressBar
                variant="fill"
                pct={fillPct}
                tone={tone}
                className={
                  "rounded-lg border px-3 py-2 transition " +
                  (st === "running"
                    ? "border-blue-500/40"
                    : st === "done"
                    ? "border-green-500/30"
                    : st === "failed"
                    ? "border-red-500/40"
                    : "border-black/[0.06] dark:border-white/[0.1]")
                }
              >
                <div className="flex items-center gap-3">
                  <StatusIcon status={st} />
                  <div className="flex-1 min-w-0 text-sm font-medium">
                    {t(`init.step_${s}`)}
                  </div>
                  <div className="text-[11px] text-neutral-500">
                    {t(`init.eta_${s}`)}
                  </div>
                </div>
              </ProgressBar>
            </li>
          );
        })}
      </ol>

      {showTerminal && (
        <div className="rounded-xl overflow-hidden border border-black/[0.08] dark:border-white/[0.08] shadow-inner">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-black/40 border-b border-white/5">
            <span
              className={
                "w-2 h-2 rounded-full " +
                (activeStep && stepStatus(activeStep).state === "running"
                  ? "bg-blue-500 animate-pulse"
                  : anyFailed
                  ? "bg-red-500"
                  : "bg-neutral-400")
              }
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
        {anyFailed ? (
          <button
            onClick={start}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-500 hover:bg-blue-600 text-white shadow-sm"
          >
            ↻ {t("common.retry")}
          </button>
        ) : (
          <p className="text-xs text-neutral-500">{t("init.in_progress")}</p>
        )}
      </div>
    </div>
  );
}
