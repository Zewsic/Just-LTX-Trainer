import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Mono, Pill, Spinner } from "./ui";
import { BuildPart, useTasks } from "../lib/tasks";

export default function BuildProgress({
  projectName,
  onDone,
}: {
  projectName: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const tasks = useTasks();
  const state = tasks.builds.get(projectName);
  const reportedDoneRef = useRef(false);

  // Когда статус → done, дёргаем onDone один раз
  useEffect(() => {
    if (state?.status === "done" && !reportedDoneRef.current) {
      reportedDoneRef.current = true;
      onDone();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.status]);

  if (!state) {
    return (
      <div className="text-xs text-neutral-500 flex items-center gap-2">
        <Spinner /> {t("ds.prep.build_running")}
      </div>
    );
  }

  const totalVideos = state.videos_total ?? 0;
  const doneVideos = state.videos_done;
  const pct =
    totalVideos > 0
      ? (doneVideos / totalVideos) * 100
      : state.status === "zipping" || state.status === "done"
      ? 100
      : 0;

  return (
    <div className="space-y-3">
      {/* Единый прогресс-бар сверху */}
      <div>
        <div className="flex items-baseline justify-between text-xs mb-1.5">
          <span className="text-neutral-500">
            {state.status === "zipping" ? (
              <span className="inline-flex items-center gap-1.5">
                <Spinner /> packing zip…
              </span>
            ) : state.status === "done" ? (
              "✓ done"
            ) : state.status === "failed" ? (
              "✕ failed"
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <Spinner /> building
              </span>
            )}
          </span>
          <span className="font-mono tabular-nums">
            {doneVideos}/{totalVideos || "?"}
            {pct > 0 && ` · ${pct.toFixed(0)}%`}
          </span>
        </div>
        <div className="h-2 rounded-full bg-black/[0.06] dark:bg-white/[0.08] overflow-hidden">
          <div
            className={
              "h-full transition-[width] " +
              (state.status === "failed"
                ? "bg-red-500"
                : state.status === "done"
                ? "bg-green-500"
                : "bg-blue-500")
            }
            style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
          />
        </div>
      </div>

      {/* Список партов */}
      {state.parts.length > 0 && (
        <ul className="rounded-xl border border-black/[0.08] dark:border-white/[0.1] divide-y divide-black/[0.05] dark:divide-white/[0.07] max-h-72 overflow-auto">
          {state.parts.map((p, i) => (
            <PartRow key={i} part={p} />
          ))}
        </ul>
      )}

      {state.error && (
        <div className="text-xs text-red-500">
          <div className="font-medium mb-1">{t("ds.prep.build_failed")}</div>
          <Mono>{state.error}</Mono>
        </div>
      )}
    </div>
  );
}

function PartRow({ part }: { part: BuildPart }) {
  return (
    <li className="px-3 py-2 flex items-center gap-3 text-sm">
      <Status status={part.status} />
      <span
        className={
          "flex-1 truncate font-mono text-xs " +
          (part.status === "done"
            ? "text-neutral-700 dark:text-neutral-300"
            : part.status === "failed"
            ? "text-red-500"
            : "text-neutral-500")
        }
      >
        {part.name}
      </span>
      {part.status === "running" && (
        <Pill tone="info">
          <Spinner className="w-3 h-3" />
        </Pill>
      )}
    </li>
  );
}

function Status({ status }: { status: BuildPart["status"] }) {
  if (status === "done")
    return (
      <span className="w-5 h-5 inline-flex items-center justify-center rounded-full bg-green-500/20 text-green-600 dark:text-green-400 text-[10px]">
        ✓
      </span>
    );
  if (status === "failed")
    return (
      <span className="w-5 h-5 inline-flex items-center justify-center rounded-full bg-red-500/20 text-red-500 text-[10px]">
        ✕
      </span>
    );
  return (
    <span className="w-5 h-5 inline-flex items-center justify-center rounded-full bg-blue-500/20">
      <span className="block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
    </span>
  );
}
