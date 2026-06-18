import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Mono, ProgressBar, StatusIcon } from "./ui";
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
        <ProgressBar />
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

  const tone =
    state.status === "failed"
      ? "err"
      : state.status === "done"
      ? "ok"
      : "info";
  const headline =
    state.status === "zipping"
      ? t("ds.prep.build_zipping")
      : state.status === "done"
      ? t("ds.prep.build_finished")
      : state.status === "failed"
      ? t("ds.prep.build_failed")
      : t("ds.prep.build_running");

  return (
    <div className="space-y-3">
      <ProgressBar
        pct={pct}
        tone={tone}
        label={headline}
        value={
          <>
            {doneVideos}/{totalVideos || "?"}
            {pct > 0 && ` · ${pct.toFixed(0)}%`}
          </>
        }
      />

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
      <StatusIcon status={part.status} size="sm" />
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
    </li>
  );
}

