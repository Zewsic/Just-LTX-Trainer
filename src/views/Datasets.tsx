import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Card, Field, Input, Select, Toggle } from "../components/ui";
import Modal from "../components/Modal";
import { Project, createProject } from "../lib/projects";
import { useTasks } from "../lib/tasks";
import PrepTab from "./datasets/PrepTab";
import UploadTab from "./datasets/UploadTab";

const NEW_SENTINEL = "__new__";

export default function Datasets({
  onGoTraining,
}: {
  onGoTraining: () => void;
}) {
  const { t } = useTranslation();
  const tasks = useTasks();
  const projects = tasks.projectList;

  const [project, setProject] = useState<Project | null>(null);
  const [tab, setTab] = useState<"prep" | "upload" | "projects">("prep");
  const hidden = tasks.hiddenProjects;
  const visibleProjects = useMemo(
    () => (projects ? projects.filter((n) => !hidden.has(n)) : null),
    [projects, hidden],
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const saveTimer = useRef<number | null>(null);
  const projectRef = useRef<Project | null>(null);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  // первый проект из списка
  useEffect(() => {
    if (project || !projects) return;
    if (projects.length === 0) {
      setCreateOpen(true);
      return;
    }
    const pick = (visibleProjects && visibleProjects[0]) ?? projects[0];
    tasks.loadProjectByName(pick).then((p) => {
      if (p) setProject(p);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

  // если текущий проект скрыли — переключаемся на первый видимый
  useEffect(() => {
    if (!project || !visibleProjects) return;
    if (hidden.has(project.name) && visibleProjects.length > 0) {
      tasks.loadProjectByName(visibleProjects[0]).then((p) => {
        if (p) setProject(p);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden, project?.name]);

  function handleSelect(value: string) {
    if (value === NEW_SENTINEL) {
      setCreateOpen(true);
      return;
    }
    if (!value || value === project?.name) return;
    tasks
      .loadProjectByName(value)
      .then((p) => {
        if (p) setProject(p);
      })
      .catch((e) => setError(String(e)));
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    try {
      const p = await createProject(name);
      setNewName("");
      setCreateOpen(false);
      setProject(p);
      await tasks.reloadProjectList();
    } catch (e: any) {
      setError(String(e));
    }
  }

  function patchProject(mut: (p: Project) => Project) {
    setProject((prev) => (prev ? mut(prev) : prev));
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const cur = projectRef.current;
      if (!cur) return;
      try {
        const saved = await tasks.saveProject(cur);
        setProject((prev) =>
          prev && prev.name === saved.name ? saved : prev,
        );
        setSavedFlash(true);
        window.setTimeout(() => setSavedFlash(false), 1200);
      } catch (e: any) {
        setError(String(e));
      }
    }, 500);
  }

  return (
    <div className="space-y-4 max-w-4xl">
      <Card>
        <div className="flex items-end gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-xs text-neutral-500 mb-1.5">{t("ds.project")}</div>
            <Select
              value={project?.name ?? ""}
              onChange={(e) => handleSelect(e.target.value)}
            >
              {projects === null ? (
                <option>…</option>
              ) : (
                <>
                  {!project && <option value="">—</option>}
                  {(visibleProjects ?? projects).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                  <option value={NEW_SENTINEL}>{t("ds.new_project")}</option>
                </>
              )}
            </Select>
          </div>
          <Toggle<"prep" | "upload" | "projects">
            value={tab}
            onChange={setTab}
            items={[
              { id: "prep", label: t("ds.tab_prep") },
              { id: "upload", label: t("ds.tab_upload") },
              { id: "projects", label: t("ds.tab_projects") },
            ]}
          />
        </div>
        {error && (
          <p className="mt-3 text-xs text-red-500 font-mono break-all">{error}</p>
        )}
      </Card>

      {project && tab === "prep" && (
        <PrepTab
          project={project}
          onChange={patchProject}
          savedFlash={savedFlash}
          onReloadProject={async () => {
            const fresh = await tasks.loadProjectByName(project.name);
            if (fresh) setProject(fresh);
          }}
          onGoUpload={() => setTab("upload")}
        />
      )}
      {project && tab === "upload" && (
        <UploadTab
          project={project}
          onProjectReload={async () => {
            const fresh = await tasks.loadProjectByName(project.name);
            if (fresh) setProject(fresh);
          }}
          onGoTraining={onGoTraining}
        />
      )}
      {tab === "projects" && (
        <ProjectsManageCard
          allProjects={projects ?? []}
          hidden={hidden}
          onToggleHidden={(name, h) => tasks.setProjectHidden(name, h)}
          currentName={project?.name ?? null}
        />
      )}
      {!project && projects !== null && projects.length === 0 && !createOpen && (
        <Card>
          <p className="text-sm text-neutral-500">…</p>
        </Card>
      )}

      <Modal
        open={createOpen}
        onClose={() => {
          // если ни одного проекта нет, не позволяем закрыть пустоту
          if (projects && projects.length === 0) return;
          setCreateOpen(false);
        }}
        title={t("ds.new_project_title")}
        footer={
          <>
            {projects && projects.length > 0 && (
              <Button variant="ghost" onClick={() => setCreateOpen(false)}>
                {t("common.cancel")}
              </Button>
            )}
            <Button onClick={handleCreate} disabled={!newName.trim()}>
              {t("ds.new_project_create")}
            </Button>
          </>
        }
      >
        <Field label={t("ds.new_project_name")}>
          <Input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="my-dataset"
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim()) handleCreate();
            }}
          />
        </Field>
      </Modal>
    </div>
  );
}

function ProjectsManageCard({
  allProjects,
  hidden,
  onToggleHidden,
  currentName,
}: {
  allProjects: string[];
  hidden: Set<string>;
  onToggleHidden: (name: string, hidden: boolean) => void;
  currentName: string | null;
}) {
  const { t } = useTranslation();
  if (allProjects.length === 0) {
    return (
      <Card>
        <p className="text-sm text-neutral-500">{t("ds.projects.empty")}</p>
      </Card>
    );
  }
  return (
    <Card title={t("ds.projects.title")}>
      <p className="text-xs text-neutral-500 mb-3">{t("ds.projects.hint")}</p>
      <ul className="-mx-5 divide-y divide-black/[0.05] dark:divide-white/[0.07]">
        {allProjects.map((name) => {
          const isHidden = hidden.has(name);
          const isCurrent = name === currentName;
          return (
            <li
              key={name}
              className="flex items-center gap-3 px-5 py-2.5 text-sm"
            >
              <span
                className={
                  "flex-1 truncate " +
                  (isHidden ? "text-neutral-400 dark:text-neutral-500" : "")
                }
              >
                {name}
                {isCurrent && (
                  <span className="ml-2 text-[10px] uppercase tracking-wider text-neutral-400">
                    {t("ds.projects.current")}
                  </span>
                )}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onToggleHidden(name, !isHidden)}
              >
                {isHidden ? t("ds.projects.show") : t("ds.projects.hide")}
              </Button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
