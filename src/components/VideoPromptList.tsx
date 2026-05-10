import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Button, Card, Pill, Spinner, Textarea } from "./ui";
import Modal from "./Modal";
import { basename, Project, saveProject } from "../lib/projects";

const COLLAPSED_LIMIT = 3;

interface CaptionEntry {
  media_path: string;
  caption: string;
}

interface PartRow {
  media_path: string;
  filename: string;
  source_path: string;
  source_name: string;
  part: number;
}

function stemOfPath(p: string): string {
  const f = basename(p);
  const dot = f.lastIndexOf(".");
  return dot > 0 ? f.slice(0, dot) : f;
}

function buildPartsList(project: Project): PartRow[] {
  const seen = new Set<string>();
  const rows: PartRow[] = [];
  for (const v of project.videos) {
    if (seen.has(v.path)) continue; // дедуп на лету
    seen.add(v.path);
    const stem = stemOfPath(v.path);
    const n = project.last_build_clips?.[v.path] ?? 0;
    for (let i = 1; i <= n; i++) {
      const filename = `${stem}_part${i}.mp4`;
      rows.push({
        media_path: `ready/${filename}`,
        filename,
        source_path: v.path,
        source_name: basename(v.path),
        part: i,
      });
    }
  }
  return rows;
}

function applyServerCaptions(
  project: Project,
  entries: CaptionEntry[],
): Project {
  const byStem = new Map<string, string>();
  for (const e of entries) {
    const f = e.media_path.replace(/^ready\//, "");
    const m = f.match(/^(.*)_part(\d+)\.[^.]+$/);
    if (!m) continue;
    const stem = m[1];
    const part = parseInt(m[2], 10);
    if (part === 1 && !byStem.has(stem)) {
      byStem.set(stem, e.caption);
    }
  }
  return {
    ...project,
    videos: project.videos.map((v) => {
      const stem = stemOfPath(v.path);
      const cap = byStem.get(stem);
      return cap !== undefined ? { ...v, prompt: cap } : v;
    }),
  };
}

export default function VideoPromptList({
  project,
  apiKey,
  podId,
  onProjectUpdated,
  refreshKey,
}: {
  project: Project;
  apiKey: string;
  podId: string;
  onProjectUpdated: (p: Project) => void;
  refreshKey?: number;
}) {
  const { t } = useTranslation();

  const parts = useMemo(() => buildPartsList(project), [project]);
  const [captionsByPath, setCaptionsByPath] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [expanded, setExpanded] = useState(false);
  const [editFor, setEditFor] = useState<string | null>(null); // media_path
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const [pulling, setPulling] = useState(false);
  const [pullDoneFlash, setPullDoneFlash] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);

  async function reloadCaptions() {
    setLoading(true);
    setError(null);
    try {
      const list = await invoke<CaptionEntry[]>("fetch_pod_captions", {
        apiKey,
        podId,
        projectName: project.name,
      });
      const map: Record<string, string> = {};
      for (const e of list) map[e.media_path] = e.caption;
      setCaptionsByPath(map);
    } catch (e: any) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reloadCaptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [podId, project.name, project.last_build_hash, refreshKey]);

  async function pushCaptions(next: Record<string, string>) {
    setSaving(true);
    try {
      // Собираем итоговый массив: только парты, у которых есть caption
      const entries = parts
        .map((p) => ({
          media_path: p.media_path,
          caption: next[p.media_path] ?? "",
        }))
        .filter((e) => e.caption.trim().length > 0);
      await invoke("write_pod_captions", {
        apiKey,
        podId,
        projectName: project.name,
        entries,
      });
      setCaptionsByPath(next);
    } finally {
      setSaving(false);
    }
  }

  function openEdit(media_path: string) {
    setEditFor(media_path);
    setDraft(captionsByPath[media_path] ?? "");
  }

  async function saveEdit() {
    if (!editFor) return;
    const next = { ...captionsByPath };
    const v = draft.trim();
    if (v) next[editFor] = v;
    else delete next[editFor];
    setEditFor(null);
    setDraft("");
    await pushCaptions(next);
  }

  async function clearOne(media_path: string) {
    const next = { ...captionsByPath };
    delete next[media_path];
    await pushCaptions(next);
  }

  async function pull() {
    setPulling(true);
    setPullError(null);
    try {
      const entries = await invoke<CaptionEntry[]>("fetch_pod_captions", {
        apiKey,
        podId,
        projectName: project.name,
      });
      const next = applyServerCaptions(project, entries);
      const saved = await saveProject(next);
      onProjectUpdated(saved);
      setPullDoneFlash(true);
      setTimeout(() => setPullDoneFlash(false), 1500);
    } catch (e: any) {
      setPullError(String(e));
    } finally {
      setPulling(false);
    }
  }

  if (parts.length === 0) {
    return null;
  }

  const visible = expanded ? parts : parts.slice(0, COLLAPSED_LIMIT);
  const hidden = Math.max(0, parts.length - COLLAPSED_LIMIT);

  return (
    <Card title={t("ds.prompts.title")}>
      <p className="text-sm text-neutral-500 mb-4">{t("ds.prompts.intro")}</p>

      {error && (
        <div className="mb-3 text-xs text-red-500 font-mono break-all">
          {error}
        </div>
      )}

      {loading && Object.keys(captionsByPath).length === 0 ? (
        <div className="text-sm text-neutral-500 flex items-center gap-2">
          <Spinner /> …
        </div>
      ) : (
        <>
          <ul className="-mx-5 divide-y divide-black/[0.05] dark:divide-white/[0.07]">
            {visible.map((p) => (
              <PartRowView
                key={p.media_path}
                row={p}
                caption={captionsByPath[p.media_path]}
                onEdit={() => openEdit(p.media_path)}
                onClear={() => clearOne(p.media_path)}
              />
            ))}
          </ul>
          {hidden > 0 && (
            <div className="mt-3 flex justify-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setExpanded((x) => !x)}
              >
                {expanded
                  ? t("ds.prompts.show_less")
                  : t("ds.prompts.show_more", { n: hidden })}
              </Button>
            </div>
          )}
        </>
      )}

      <div className="mt-5 pt-4 border-t border-black/[0.06] dark:border-white/[0.08]">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">{t("ds.prompts.pull_title")}</div>
            <div className="text-xs text-neutral-500 mt-0.5">
              {t("ds.prompts.pull_hint")}
            </div>
            {pullError && (
              <div className="mt-2 text-xs text-red-500 font-mono break-all">
                {pullError}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {pullDoneFlash && (
              <Pill tone="ok">✓ {t("ds.prompts.pull_done")}</Pill>
            )}
            <Button onClick={pull} disabled={pulling}>
              {pulling ? (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner /> {t("ds.prompts.pulling")}
                </span>
              ) : (
                t("ds.prompts.pull")
              )}
            </Button>
          </div>
        </div>
      </div>

      <Modal
        open={editFor !== null}
        onClose={() => {
          if (!saving) {
            setEditFor(null);
            setDraft("");
          }
        }}
        title={
          editFor
            ? t("ds.prompts.modal_title", {
                name: editFor.replace(/^ready\//, ""),
              })
            : ""
        }
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setEditFor(null);
                setDraft("");
              }}
              disabled={saving}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={saveEdit} disabled={saving}>
              {saving ? <Spinner /> : t("ds.prompts.save")}
            </Button>
          </>
        }
      >
        <Textarea
          autoFocus
          rows={6}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </Modal>
    </Card>
  );
}

function PartRowView({
  row,
  caption,
  onEdit,
  onClear,
}: {
  row: PartRow;
  caption?: string;
  onEdit: () => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const has = !!(caption && caption.trim());
  return (
    <li className="px-5 py-3 flex items-start gap-4">
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm truncate">{row.filename}</div>
        <div className="text-[11px] text-neutral-500 truncate">
          {row.source_name} · part {row.part}
        </div>
        {has ? (
          <div className="text-xs mt-1.5 text-neutral-700 dark:text-neutral-300 line-clamp-2 italic">
            “{caption}”
          </div>
        ) : (
          <div className="text-xs mt-1 text-neutral-500">—</div>
        )}
      </div>
      <div className="flex gap-1.5 shrink-0">
        <Button size="sm" variant="ghost" onClick={onEdit}>
          {has ? t("ds.prompts.edit") : t("ds.prompts.add")}
        </Button>
        {has && (
          <Button size="sm" variant="ghost" onClick={onClear}>
            {t("ds.prompts.clear")}
          </Button>
        )}
      </div>
    </li>
  );
}
