import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Button, Card, Pill, Row } from "../components/ui";
import { useTasks } from "../lib/tasks";

interface LocalResults {
  dir: string;
  checkpoint_count: number;
  sample_count: number;
}

export default function Project() {
  const { t } = useTranslation();
  const tasks = useTasks();
  const projects = tasks.projectList;
  const hidden = tasks.hiddenProjects;

  const [selected, setSelected] = useState<string | null>(null);
  const project = selected ? tasks.projects.get(selected) ?? null : null;

  // выбираем первый видимый проект по умолчанию
  useEffect(() => {
    if (selected || !projects || projects.length === 0) return;
    const visible = projects.filter((n) => !hidden.has(n));
    setSelected((visible[0] ?? projects[0]) ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

  useEffect(() => {
    if (selected) tasks.loadProjectByName(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const [results, setResults] = useState<LocalResults | null>(null);
  useEffect(() => {
    if (!selected) {
      setResults(null);
      return;
    }
    let cancelled = false;
    invoke<LocalResults>("list_local_results", { projectName: selected })
      .then((r) => {
        if (!cancelled) setResults(r);
      })
      .catch(() => {
        if (!cancelled) setResults(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const clipCount = useMemo(() => {
    if (!project) return 0;
    return Object.values(project.last_build_clips || {}).reduce(
      (a, b) => a + (b ?? 0),
      0,
    );
  }, [project]);

  const hasResults =
    !!results && (results.checkpoint_count > 0 || results.sample_count > 0);

  return (
    <div className="space-y-4 max-w-4xl">
      <ProjectsListCard
        allProjects={projects ?? []}
        hidden={hidden}
        currentName={selected}
        onSelect={setSelected}
        onToggleHidden={(name, h) => tasks.setProjectHidden(name, h)}
      />

      {project && (
        <Card title={t("proj.detail_title")}>
          <div className="space-y-1">
            <Row
              k={t("proj.detail_created")}
              v={new Date(project.created_at).toLocaleString()}
            />
            <Row
              k={t("proj.detail_updated")}
              v={new Date(project.updated_at).toLocaleString()}
            />
            <Row k={t("proj.detail_clips")} v={String(clipCount)} />
            {project.training?.rank != null && (
              <Row k={t("proj.detail_rank")} v={String(project.training.rank)} />
            )}
            {project.training?.steps != null && (
              <Row
                k={t("proj.detail_steps")}
                v={String(project.training.steps)}
              />
            )}
            {project.training?.mode && (
              <Row k={t("proj.detail_mode")} v={project.training.mode} />
            )}
            {project.training?.rank == null &&
              project.training?.steps == null &&
              !project.training?.mode && (
                <p className="text-xs text-neutral-500 pt-1">
                  {t("proj.detail_no_training")}
                </p>
              )}
          </div>
        </Card>
      )}

      {project && (
        <Card title={t("proj.results_title")}>
          <p className="text-xs text-neutral-500 mb-3">
            {t("proj.results_hint")}
          </p>
          {hasResults ? (
            <div className="flex items-center gap-3 flex-wrap">
              <Pill tone="ok">
                {t("proj.results_checkpoints", {
                  n: results!.checkpoint_count,
                })}
              </Pill>
              <Pill tone="info">
                {t("proj.results_samples", { n: results!.sample_count })}
              </Pill>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  invoke("reveal_in_file_manager", {
                    path: results!.dir,
                  }).catch(() => {})
                }
              >
                {t("proj.results_open")}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-neutral-500">
              {t("proj.results_empty")}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}

function ProjectsListCard({
  allProjects,
  hidden,
  currentName,
  onSelect,
  onToggleHidden,
}: {
  allProjects: string[];
  hidden: Set<string>;
  currentName: string | null;
  onSelect: (name: string) => void;
  onToggleHidden: (name: string, hidden: boolean) => void;
}) {
  const { t } = useTranslation();
  if (allProjects.length === 0) {
    return (
      <Card title={t("proj.list_title")}>
        <p className="text-sm text-neutral-500">{t("proj.empty")}</p>
      </Card>
    );
  }
  return (
    <Card title={t("proj.list_title")}>
      <p className="text-xs text-neutral-500 mb-3">{t("proj.list_hint")}</p>
      <ul className="-mx-5 divide-y divide-black/[0.05] dark:divide-white/[0.07]">
        {allProjects.map((name) => {
          const isHidden = hidden.has(name);
          const isCurrent = name === currentName;
          return (
            <li
              key={name}
              className="flex items-center gap-3 px-5 py-2.5 text-sm"
            >
              <button
                onClick={() => onSelect(name)}
                className={
                  "flex-1 min-w-0 truncate text-left " +
                  (isHidden ? "text-neutral-400 dark:text-neutral-500" : "") +
                  (isCurrent ? " font-medium" : "")
                }
              >
                {name}
                {isCurrent && (
                  <span className="ml-2 text-[10px] uppercase tracking-wider text-neutral-400">
                    {t("proj.current")}
                  </span>
                )}
              </button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onToggleHidden(name, !isHidden)}
              >
                {isHidden ? t("proj.unarchive") : t("proj.archive")}
              </Button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
