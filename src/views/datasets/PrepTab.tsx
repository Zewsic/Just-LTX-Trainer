import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { open as openShell } from "@tauri-apps/plugin-shell";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke } from "@tauri-apps/api/core";
import { Button, Card, Mono, Pill, Spinner, Textarea } from "../../components/ui";
import Modal from "../../components/Modal";
import BuildProgress from "../../components/BuildProgress";
import { useTasks } from "../../lib/tasks";
import {
  ASPECT_OPTIONS,
  basename,
  buildSnapshotHash,
  LENGTH_OPTIONS,
  lengthToFrames,
  LocalTools,
  Project,
  VideoEntry,
} from "../../lib/projects";

const VIDEO_EXT = [".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"];

function isVideo(p: string) {
  const lower = p.toLowerCase();
  return VIDEO_EXT.some((ext) => lower.endsWith(ext));
}

export default function PrepTab({
  project,
  onChange,
  savedFlash,
  onReloadProject,
  onGoUpload,
}: {
  project: Project;
  onChange: (mut: (p: Project) => Project) => void;
  savedFlash: boolean;
  onReloadProject: () => Promise<void>;
  onGoUpload: () => void;
}) {
  const { t } = useTranslation();
  const tasksApi = useTasks();
  const tools = tasksApi.localTools;
  const installing = tasksApi.installing.ffmpeg.running;
  const installLog = tasksApi.installing.ffmpeg.log;
  const [promptFor, setPromptFor] = useState<number | null>(null);
  const [promptDraft, setPromptDraft] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const [currentHash, setCurrentHash] = useState<string | null>(null);

  const projectRef = useRef(project);
  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  // Пересчёт хэша при изменении настроек / видео / промптов
  useEffect(() => {
    let cancelled = false;
    buildSnapshotHash(project).then((h) => {
      if (!cancelled) setCurrentHash(h);
    });
    return () => {
      cancelled = true;
    };
  }, [
    project.aspect_ratio,
    project.no_resize_video,
    project.length_seconds,
    project.overlap,
    project.videos,
  ]);

  const isFresh = useMemo(
    () =>
      !!project.last_build_hash &&
      !!project.last_build_zip &&
      currentHash === project.last_build_hash,
    [project.last_build_hash, project.last_build_zip, currentHash],
  );

  // Tools-state живёт в TasksProvider; провайдер сам их подгружает на старте.
  useEffect(() => {
    if (tools && tools.has_brew && tools.has_ffmpeg && !project.local_setup_done) {
      onChange((p) => ({ ...p, local_setup_done: true }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tools?.has_brew, tools?.has_ffmpeg]);

  // Drag&drop файлов в окно
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (!alive) return;
        const p: any = event.payload;
        if (p.type === "over" || p.type === "enter") setDragOver(true);
        else if (p.type === "leave") setDragOver(false);
        else if (p.type === "drop") {
          setDragOver(false);
          const paths: string[] = p.paths ?? [];
          if (paths.length) addPaths(paths);
        }
      })
      .then((u) => {
        // если компонент уже размонтирован — сразу отписываемся,
        // иначе старые слушатели накапливаются и каждое событие dnd
        // обрабатывается N раз → видео дублируются.
        if (!alive) {
          u();
          return;
        }
        unlisten = u;
      });
    return () => {
      alive = false;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addPaths(paths: string[]) {
    const accepted = paths.filter(isVideo);
    if (accepted.length === 0) return;
    // Дедуп делаем ВНУТРИ setState-апдейтера: иначе при двух параллельных
    // вызовах оба видят один снимок и оба добавляют новые пути.
    onChange((p) => {
      const existing = new Set(p.videos.map((v) => v.path));
      const newOnes: VideoEntry[] = accepted
        .filter((x) => !existing.has(x))
        .map((x) => ({ path: x, prompt: null }));
      if (newOnes.length === 0) return p;
      return { ...p, videos: [...p.videos, ...newOnes] };
    });
  }

  // doInstall теперь живёт в провайдере
  const doInstall = () => tasksApi.installFfmpeg();

  async function pickVideos() {
    const sel = await openDialog({
      multiple: true,
      directory: false,
      filters: [
        { name: "Video", extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v"] },
      ],
    });
    if (!sel) return;
    addPaths(Array.isArray(sel) ? sel : [sel]);
  }

  function removeVideo(idx: number) {
    onChange((p) => ({ ...p, videos: p.videos.filter((_, i) => i !== idx) }));
  }

  function openPromptModal(idx: number) {
    setPromptFor(idx);
    setPromptDraft(project.videos[idx]?.prompt ?? "");
  }

  function savePrompt() {
    if (promptFor === null) return;
    const idx = promptFor;
    const value = promptDraft.trim();
    onChange((p) => ({
      ...p,
      videos: p.videos.map((v, i) =>
        i === idx ? { ...v, prompt: value || null } : v,
      ),
    }));
    setPromptFor(null);
    setPromptDraft("");
  }

  function clearPrompt(idx: number) {
    onChange((p) => ({
      ...p,
      videos: p.videos.map((v, i) =>
        i === idx ? { ...v, prompt: null } : v,
      ),
    }));
  }

  const allOk = tools?.has_brew && tools?.has_ffmpeg;

  return (
    <div className="space-y-4 relative">
      {/* Tools card — показываем только если что-то не ок */}
      {tools && !allOk && tools.os !== "macos" && tools.os !== "darwin" ? (
        <Card title={t("ds.prep.tools_title")}>
          <p className="text-sm text-neutral-500">{t("ds.prep.macos_only")}</p>
        </Card>
      ) : tools && !allOk ? (
        <ToolsCard
          tools={tools}
          installing={installing}
          installLog={installLog}
          onInstall={doInstall}
        />
      ) : !tools ? (
        <Card title={t("ds.prep.tools_title")}>
          <div className="flex items-center gap-2 text-sm text-neutral-500">
            <Spinner /> {t("common.loading")}
          </div>
        </Card>
      ) : null}

      {allOk && (
        <>
          <Card
            title={t("ds.prep.videos_title")}
            action={
              <Button size="sm" onClick={pickVideos}>
                ＋ {t("ds.prep.add_videos")}
              </Button>
            }
          >
            {project.videos.length === 0 ? (
              <p className="text-sm text-neutral-500">{t("ds.prep.no_videos")}</p>
            ) : (
              <ul className="-mx-5 divide-y divide-black/[0.05] dark:divide-white/[0.07]">
                {project.videos.map((v, i) => (
                  <VideoRow
                    key={v.path + i}
                    v={v}
                    onEditPrompt={() => openPromptModal(i)}
                    onClearPrompt={() => clearPrompt(i)}
                    onRemove={() => removeVideo(i)}
                  />
                ))}
              </ul>
            )}
          </Card>

          <Card title={t("ds.prep.settings_title")}>
            <div className="space-y-5">
              <div>
                <SectionLabel>{t("ds.prep.aspect")}</SectionLabel>
                <div className="flex flex-wrap gap-2 items-stretch">
                  {ASPECT_OPTIONS.map((a) => (
                    <Tile
                      key={a}
                      active={
                        !project.no_resize_video &&
                        project.aspect_ratio === a
                      }
                      onClick={() =>
                        onChange((p) => ({
                          ...p,
                          aspect_ratio: a,
                          no_resize_video: false,
                        }))
                      }
                      label={a}
                      dim={project.no_resize_video}
                    >
                      <AspectVisual ratio={a} />
                    </Tile>
                  ))}
                  <Tile
                    active={project.no_resize_video}
                    onClick={() =>
                      onChange((p) => ({
                        ...p,
                        no_resize_video: !p.no_resize_video,
                      }))
                    }
                    label={t("ds.prep.no_resize")}
                  >
                    <NoResizeIcon />
                  </Tile>
                </div>
                {project.no_resize_video && (
                  <p className="text-[11px] text-neutral-500 mt-2 max-w-md leading-snug">
                    {t("ds.prep.no_resize_hint")}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap gap-x-10 gap-y-5">
                <div>
                  <SectionLabel>{t("ds.prep.length")}</SectionLabel>
                  <div className="flex gap-2">
                    {LENGTH_OPTIONS.map((sec) => (
                      <Tile
                        key={sec}
                        active={Math.abs(project.length_seconds - sec) < 0.05}
                        onClick={() =>
                          onChange((p) => ({ ...p, length_seconds: sec }))
                        }
                        label={
                          sec === 3.7
                            ? t("ds.prep.length_3_7")
                            : t("ds.prep.length_5_0")
                        }
                        sublabel={
                          project.no_resize_video
                            ? t("ds.prep.frames_native")
                            : t("ds.prep.frames_at_24", {
                                n: lengthToFrames(sec),
                              })
                        }
                      >
                        <ClockIcon />
                      </Tile>
                    ))}
                  </div>
                </div>

                <div>
                  <SectionLabel>{t("ds.prep.overlap")}</SectionLabel>
                  <div className="flex gap-2">
                    <Tile
                      active={project.overlap}
                      onClick={() => onChange((p) => ({ ...p, overlap: true }))}
                      label={t("ds.prep.overlap_on")}
                    >
                      <OverlapIcon on />
                    </Tile>
                    <Tile
                      active={!project.overlap}
                      onClick={() => onChange((p) => ({ ...p, overlap: false }))}
                      label={t("ds.prep.overlap_off")}
                    >
                      <OverlapIcon on={false} />
                    </Tile>
                  </div>
                </div>

                <div>
                  <SectionLabel>{t("ds.prep.audio")}</SectionLabel>
                  <div className="flex gap-2">
                    <Tile
                      active={!!project.audio}
                      onClick={() => onChange((p) => ({ ...p, audio: true }))}
                      label={t("ds.prep.audio_on")}
                    >
                      <AudioIcon on />
                    </Tile>
                    <Tile
                      active={!project.audio}
                      onClick={() => onChange((p) => ({ ...p, audio: false }))}
                      label={t("ds.prep.audio_off")}
                    >
                      <AudioIcon on={false} />
                    </Tile>
                  </div>
                </div>
              </div>
            </div>
          </Card>

          {tasksApi.isBuilding(project.name) ? (
            <Card>
              <BuildProgress
                projectName={project.name}
                onDone={async () => {
                  await onReloadProject();
                }}
              />
            </Card>
          ) : isFresh && project.last_build_zip ? (
            <Card>
              <div className="flex items-start gap-4">
                <span className="w-9 h-9 rounded-full bg-green-500/15 text-green-600 dark:text-green-400 inline-flex items-center justify-center text-lg shrink-0">
                  ✓
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold">
                    {t("ds.prep.build_done_title")}
                  </div>
                  <div className="text-xs text-neutral-500 mt-0.5 truncate">
                    {project.last_build_zip}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      const dest = await saveDialog({
                        defaultPath: `${project.name}.zip`,
                        filters: [{ name: "Zip", extensions: ["zip"] }],
                      });
                      if (!dest) return;
                      try {
                        await invoke("copy_file", {
                          src: project.last_build_zip,
                          dst: dest,
                        });
                      } catch (e) {
                        console.error(e);
                      }
                    }}
                  >
                    {t("ds.prep.save_as")}
                  </Button>
                  <Button size="sm" onClick={onGoUpload}>
                    {t("ds.prep.go_upload")}
                  </Button>
                </div>
              </div>
            </Card>
          ) : (
            <div className="flex justify-end items-center gap-3">
              {savedFlash && (
                <span className="text-xs text-green-600 dark:text-green-400">
                  {t("ds.prep.saved")}
                </span>
              )}
              {project.last_build_hash && !isFresh && (
                <span className="text-xs text-amber-600 dark:text-amber-400">
                  {t("ds.prep.build_outdated")}
                </span>
              )}
              <Button
                onClick={() => {
                  if (!currentHash) return;
                  // не ждём — провайдер берёт на себя весь жизненный цикл
                  tasksApi.startBuild({
                    project_name: project.name,
                    hash: currentHash,
                  });
                }}
                disabled={
                  project.videos.length === 0 ||
                  !currentHash ||
                  tasksApi.isBuilding(project.name)
                }
              >
                {t("ds.prep.build")}
              </Button>
            </div>
          )}
        </>
      )}

      {/* DnD overlay */}
      {dragOver && (
        <div className="fixed inset-0 z-[120] pointer-events-none flex items-center justify-center bg-blue-500/10 backdrop-blur-[2px] border-4 border-dashed border-blue-500/60 m-3 rounded-2xl">
          <div className="bg-white dark:bg-black/80 rounded-xl px-5 py-3 shadow-xl text-sm font-medium">
            ＋ {t("ds.prep.add_videos")}
          </div>
        </div>
      )}

      <Modal
        open={promptFor !== null}
        onClose={() => setPromptFor(null)}
        title={
          promptFor !== null
            ? t("ds.prep.prompt_modal_title", {
                name: basename(project.videos[promptFor]?.path ?? ""),
              })
            : ""
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setPromptFor(null)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={savePrompt}>{t("ds.prep.prompt_save")}</Button>
          </>
        }
      >
        <Textarea
          autoFocus
          rows={5}
          value={promptDraft}
          onChange={(e) => setPromptDraft(e.target.value)}
          placeholder={t("ds.prep.prompt_placeholder")}
        />
      </Modal>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-2">
      {children}
    </div>
  );
}

function Tile({
  active,
  onClick,
  label,
  sublabel,
  dim,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  sublabel?: string;
  dim?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "w-[72px] h-[96px] rounded-xl border flex flex-col items-center justify-between py-3 px-2 transition " +
        (active
          ? "border-blue-500 bg-blue-500/10 text-blue-600 dark:text-blue-400"
          : (dim
              ? "border-black/[0.05] dark:border-white/[0.06] text-neutral-400 dark:text-neutral-500 opacity-60 hover:opacity-100"
              : "border-black/[0.08] dark:border-white/[0.1] text-neutral-600 dark:text-neutral-300 hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"))
      }
    >
      <div className="flex-1 flex items-center justify-center">{children}</div>
      <div className="flex flex-col items-center gap-0.5">
        <span className="text-[12px] font-medium leading-none">{label}</span>
        {sublabel && (
          <span className="text-[10px] font-mono leading-none opacity-70">
            {sublabel}
          </span>
        )}
      </div>
    </button>
  );
}

function NoResizeIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="5" width="8" height="6" rx="1" />
      <rect x="13" y="5" width="8" height="10" rx="1" />
      <rect x="3" y="13" width="8" height="6" rx="1" />
      <path d="M21 19h-4" />
    </svg>
  );
}

function AspectVisual({ ratio }: { ratio: string }) {
  const [w, h] = ratio.split(":").map(Number);
  const max = 28;
  const scale = max / Math.max(w, h);
  const W = Math.round(w * scale);
  const H = Math.round(h * scale);
  return (
    <div
      className="rounded-[3px] border-2 border-current"
      style={{ width: W, height: H }}
    />
  );
}

function ClockIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15.5 14" />
    </svg>
  );
}

function AudioIcon({ on }: { on: boolean }) {
  if (on)
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="11 5 6 9 3 9 3 15 6 15 11 19 11 5" fill="currentColor" fillOpacity="0.2" />
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      </svg>
    );
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 3 9 3 15 6 15 11 19 11 5" />
      <line x1="22" y1="9" x2="16" y2="15" />
      <line x1="16" y1="9" x2="22" y2="15" />
    </svg>
  );
}

function OverlapIcon({ on }: { on: boolean }) {
  if (on)
    return (
      <svg width="26" height="22" viewBox="0 0 26 22" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="2" y="4" width="14" height="14" rx="2" />
        <rect x="10" y="4" width="14" height="14" rx="2" fill="currentColor" fillOpacity="0.15" />
      </svg>
    );
  return (
    <svg width="26" height="22" viewBox="0 0 26 22" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="1.5" y="4" width="10" height="14" rx="2" />
      <rect x="14.5" y="4" width="10" height="14" rx="2" />
    </svg>
  );
}

function ToolsCard({
  tools,
  installing,
  installLog,
  onInstall,
}: {
  tools: LocalTools;
  installing: boolean;
  installLog: string | null;
  onInstall: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card title={t("ds.prep.tools_title")}>
      <div className="space-y-3">
        <ToolRow
          label="Homebrew"
          ok={tools.has_brew}
          action={
            !tools.has_brew && (
              <Button size="sm" onClick={() => openShell("https://brew.sh")}>
                {t("ds.prep.brew_install")}
              </Button>
            )
          }
        />
        <ToolRow
          label="ffmpeg"
          ok={tools.has_ffmpeg}
          action={
            !tools.has_ffmpeg &&
            tools.has_brew && (
              <Button size="sm" onClick={onInstall} disabled={installing}>
                {installing ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Spinner /> {t("ds.prep.ffmpeg_installing")}
                  </span>
                ) : (
                  t("ds.prep.ffmpeg_install")
                )}
              </Button>
            )
          }
        />
        {installLog && (
          <div>
            <Mono>{installLog}</Mono>
          </div>
        )}
      </div>
    </Card>
  );
}

function ToolRow({
  label,
  ok,
  action,
}: {
  label: string;
  ok: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      {ok ? <Pill tone="ok">✓ {label}</Pill> : <Pill tone="warn">{label}</Pill>}
      <div className="flex-1" />
      {action}
    </div>
  );
}

function VideoRow({
  v,
  onEditPrompt,
  onClearPrompt,
  onRemove,
}: {
  v: VideoEntry;
  onEditPrompt: () => void;
  onClearPrompt: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const hasPrompt = !!v.prompt;
  return (
    <li className="px-5 py-3 flex items-start gap-4">
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm truncate">{basename(v.path)}</div>
        <div className="text-[11px] text-neutral-500 truncate">{v.path}</div>
        {hasPrompt && (
          <div className="text-xs mt-1.5 text-neutral-700 dark:text-neutral-300 line-clamp-2 italic">
            “{v.prompt}”
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <Button size="sm" variant="ghost" onClick={onEditPrompt}>
          {hasPrompt ? t("ds.prep.edit_prompt") : t("ds.prep.add_prompt")}
        </Button>
        {hasPrompt && (
          <Button size="sm" variant="ghost" onClick={onClearPrompt}>
            {t("ds.prep.delete_prompt")}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onRemove} className="!text-red-500">
          ✕
        </Button>
      </div>
    </li>
  );
}
