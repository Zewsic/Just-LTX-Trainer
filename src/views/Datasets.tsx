import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Card, Field, Input, Select } from "../components/ui";
import Modal from "../components/Modal";
import {
  Project,
  createProject,
  listProjects,
  loadProject,
  saveProject,
} from "../lib/projects";
import PrepTab from "./datasets/PrepTab";
import UploadTab from "./datasets/UploadTab";

const NEW_SENTINEL = "__new__";

export default function Datasets({
  onGoTraining,
}: {
  onGoTraining: () => void;
}) {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<string[] | null>(null);
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

  // initial load
  useEffect(() => {
    (async () => {
      try {
        const list = await listProjects();
        setProjects(list);
        if (list.length > 0) {
          const p = await loadProject(list[0]);
          setProject(p);
        } else {
          setCreateOpen(true);
        }
      } catch (e: any) {
        setError(String(e));
        setProjects([]);
      }
    })();
  }, []);

  async function refreshList() {
    try {
      setProjects(await listProjects());
    } catch (e: any) {
      setError(String(e));
    }
  }

  function handleSelect(value: string) {
    if (value === NEW_SENTINEL) {
      setCreateOpen(true);
      return;
    }
    if (!value || value === project?.name) return;
    loadProject(value).then(setProject).catch((e) => setError(String(e)));
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    try {
      const p = await createProject(name);
      setNewName("");
      setCreateOpen(false);
      setProject(p);
      await refreshList();
    } catch (e: any) {
      setError(String(e));
    }
  }

  // debounced auto-save
  function patchProject(mut: (p: Project) => Project) {
    setProject((prev) => (prev ? mut(prev) : prev));
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const cur = projectRef.current;
      if (!cur) return;
      try {
        const saved = await saveProject(cur);
        setProject((prev) => (prev && prev.name === saved.name ? saved : prev));
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
          <div className="inline-flex h-[38px] rounded-lg bg-black/[0.05] dark:bg-white/[0.06] p-0.5 text-xs">
            {(["prep", "upload"] as const).map((id) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={
                  "px-4 rounded-md transition " +
                  (tab === id
                    ? "bg-white dark:bg-white/[0.12] shadow-sm font-medium"
                    : "text-neutral-500 hover:text-current")
                }
              >
                {t(`ds.tab_${id}`)}
              </button>
            ))}
          </div>
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
            try {
              const fresh = await loadProject(project.name);
              setProject(fresh);
            } catch (e: any) {
              setError(String(e));
            }
          }}
          onGoUpload={() => setTab("upload")}
        />
      )}
      {project && tab === "upload" && (
        <UploadTab
          project={project}
          onProjectReload={async () => {
            try {
              const fresh = await loadProject(project.name);
              setProject(fresh);
            } catch (e: any) {
              setError(String(e));
            }
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
