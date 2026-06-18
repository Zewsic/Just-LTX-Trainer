import { useEffect, useRef, useState } from "react";
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
  const [tab, setTab] = useState<"prep" | "upload">("prep");
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
    tasks.loadProjectByName(projects[0]).then((p) => {
      if (p) setProject(p);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

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
                  {projects.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                  <option value={NEW_SENTINEL}>{t("ds.new_project")}</option>
                </>
              )}
            </Select>
          </div>
          <Toggle<"prep" | "upload">
            value={tab}
            onChange={setTab}
            items={[
              { id: "prep", label: t("ds.tab_prep") },
              { id: "upload", label: t("ds.tab_upload") },
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
