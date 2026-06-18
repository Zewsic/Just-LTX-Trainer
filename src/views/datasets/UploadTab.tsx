import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Card,
  Mono,
  Pill,
  ProgressBar,
  Select,
  Spinner,
} from "../../components/ui";
import XTermPanel, { XTermHandle } from "../../components/XTerm";
import AutoCaptionBlock from "../../components/AutoCaptionBlock";
import VideoPromptList from "../../components/VideoPromptList";
import { Project } from "../../lib/projects";
import {
  uploadKey,
  useLiveProgress,
  useSshProbe,
  useTasks,
} from "../../lib/tasks";

export default function UploadTab({
  project,
  onProjectReload,
  onGoTraining,
}: {
  project: Project;
  onProjectReload: () => Promise<void>;
  onGoTraining: () => void;
}) {
  const { t } = useTranslation();
  const tasks = useTasks();
  const apiKey = tasks.apiKey;
  const managed = tasks.managed;
  const livePods = tasks.pods;
  const tools = tasks.localTools;
  const installLog = tasks.installing.runpodctl.log;
  const installing = tasks.installing.runpodctl.running;

  // выбор пода — единственный локально-визуальный state
  const [selectedId, setSelectedId] = useState<string>("");
  useEffect(() => {
    if (selectedId) return;
    const preferred =
      managed.find((m) => m.ltx_state !== "init")?.id ?? managed[0]?.id ?? "";
    if (preferred) setSelectedId(preferred);
  }, [managed, selectedId]);

  const [error, setError] = useState<string | null>(null);
  const [captionsRefresh, setCaptionsRefresh] = useState(0);

  const probe = useSshProbe(selectedId);
  const selectedManaged = useMemo(
    () => managed.find((m) => m.id === selectedId) ?? null,
    [managed, selectedId],
  );
  const selectedLive = livePods.get(selectedId) ?? null;

  async function doUpload() {
    if (!apiKey || !selectedId) return;
    setError(null);
    const r = await tasks.startUpload({
      api_key: apiKey,
      pod_id: selectedId,
      project_name: project.name,
    });
    if (!r.ok) setError(r.error ?? "upload failed");
    await onProjectReload();
  }

  // Терминал: подписка на буфер задачи
  const termRef = useRef<XTermHandle>(null);
  const uploadLogKey = selectedId ? uploadKey(selectedId, project.name) : null;
  const isUploading =
    !!selectedId && tasks.isUploading(selectedId, project.name);
  const hasUploadLog =
    !!uploadLogKey && tasks.getLog(uploadLogKey).length > 0;
  const termVisible = isUploading || hasUploadLog;

  useEffect(() => {
    if (!uploadLogKey || !termVisible) return;
    const term = termRef.current;
    if (!term) return;
    term.reset();
    const initial = tasks.getLog(uploadLogKey);
    if (initial) term.write(initial);
    const unsub = tasks.subscribeLog(uploadLogKey, (chunk) => {
      if (chunk === "\x1b[2J\x1b[H") term.reset();
      else term.write(chunk);
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadLogKey, termVisible]);

  // фаза + прогресс — для лейбла на кнопке-прогрессе
  const progress = useLiveProgress(uploadLogKey ?? undefined, "upload");
  const phase = useMemo(() => {
    if (!uploadLogKey) return null;
    const log = tasks.getLog(uploadLogKey);
    const matches = [...log.matchAll(/# phase: (\w+)/g)];
    return matches.length ? matches[matches.length - 1][1] : null;
  }, [uploadLogKey, isUploading]);

  if (!project.last_build_hash || !project.last_build_zip) {
    return (
      <Card>
        <p className="text-sm text-neutral-500">{t("ds.upload.no_built")}</p>
      </Card>
    );
  }

  if (managed.length === 0) {
    return (
      <Card>
        <p className="text-sm text-neutral-500">{t("ds.upload.no_managed")}</p>
      </Card>
    );
  }

  const podStatus = selectedLive?.desired_status ?? "—";
  const podRunning = podStatus === "RUNNING";
  const podReady = selectedManaged && selectedManaged.ltx_state !== "init";
  const sshOk = probe?.ok === true;
  const uploaded = selectedId
    ? project.last_uploads?.[selectedId] ?? null
    : null;
  const isFresh = !!uploaded && uploaded.hash === project.last_build_hash;
  const canUpload =
    podRunning && podReady && sshOk && tools?.has_runpodctl && !isUploading;

  return (
    <div className="space-y-4">
      <Card>
        <div className="space-y-4">
          <div>
            <div className="text-xs text-neutral-500 mb-1.5">
              {t("ds.upload.server")}
            </div>
            <Select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              disabled={isUploading}
            >
              {managed.map((m) => {
                const live = livePods.get(m.id);
                const gpu = live?.gpu_display_name ?? "—";
                const count = live?.gpu_count ? ` ×${live.gpu_count}` : "";
                const phaseStr =
                  live?.desired_status === "EXITED" ||
                  live?.desired_status === "TERMINATED"
                    ? t("servers.row_stopped")
                    : live?.desired_status !== "RUNNING"
                    ? t("servers.row_provisioning")
                    : m.ltx_state === "init"
                    ? t("servers.row_setting_up")
                    : t("servers.row_ready");
                return (
                  <option key={m.id} value={m.id}>
                    {(m.name || m.id) + " · " + gpu + count + " · " + phaseStr}
                  </option>
                );
              })}
            </Select>
          </div>

          {!podRunning ? (
            <Pill tone="warn">{t("ds.upload.needs_running")}</Pill>
          ) : !podReady ? (
            <Pill tone="warn">{t("ds.upload.needs_init")}</Pill>
          ) : probe === null ? (
            <Pill tone="neutral">
              <Spinner /> {t("ds.upload.checking_ssh")}
            </Pill>
          ) : !sshOk ? (
            <Pill tone="err">{t("ds.upload.needs_ssh")}</Pill>
          ) : (
            <Pill tone="ok">✓ {t("ds.upload.ready")}</Pill>
          )}
        </div>
      </Card>

      {tools && !tools.has_runpodctl && (
        <Card>
          <div className="flex items-center gap-3">
            <Pill tone="warn">{t("ds.upload.tools_runpodctl_missing")}</Pill>
            <div className="flex-1" />
            <Button
              size="sm"
              onClick={() => tasks.installRunpodctl()}
              disabled={installing || !tools.has_brew}
            >
              {installing ? (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner /> {t("ds.upload.tools_runpodctl_installing")}
                </span>
              ) : (
                t("ds.upload.tools_runpodctl_install")
              )}
            </Button>
          </div>
          {!tools.has_brew && (
            <p className="text-xs text-neutral-500 mt-2">
              {t("ds.prep.brew_missing_title")}
            </p>
          )}
          {installLog && (
            <div className="mt-3">
              <Mono>{installLog}</Mono>
            </div>
          )}
        </Card>
      )}

      {selectedId && podReady && sshOk && tools?.has_runpodctl && (
        <Card>
          <div className="flex items-start gap-4">
            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                {isFresh ? (
                  <Pill tone="ok">✓ {t("ds.upload.fresh")}</Pill>
                ) : uploaded ? (
                  <Pill tone="warn">{t("ds.upload.stale")}</Pill>
                ) : (
                  <Pill>{t("ds.upload.never")}</Pill>
                )}
              </div>
              <div className="text-[11px] text-neutral-500 space-y-0.5">
                <div className="font-mono">
                  <span className="opacity-60">
                    {t("ds.upload.current_hash")}:{" "}
                  </span>
                  {project.last_build_hash?.slice(0, 12)}…
                </div>
                {uploaded && (
                  <div className="font-mono">
                    <span className="opacity-60">
                      {t("ds.upload.uploaded_hash")}:{" "}
                    </span>
                    {uploaded.hash.slice(0, 12)}…
                  </div>
                )}
              </div>
            </div>
            <div className="shrink-0 flex gap-2">
              {isUploading ? (
                <ProgressBar
                  variant="button"
                  pct={progress?.pct ?? 0}
                  tone="info"
                  label={
                    progress
                      ? `${progress.pct.toFixed(0)}% · ${progress.label}`
                      : phase
                      ? t(`ds.upload.phase_${phase}`, phase)
                      : t("ds.upload.uploading")
                  }
                />
              ) : (
                <Button onClick={doUpload} disabled={!canUpload}>
                  {isFresh ? t("ds.upload.reupload") : t("ds.upload.upload")}
                </Button>
              )}
              {isFresh && !isUploading && (
                <Button variant="ghost" onClick={onGoTraining}>
                  {t("tr.go_training")}
                </Button>
              )}
            </div>
          </div>

          {(isUploading || hasUploadLog) && (
            <div className="mt-4 space-y-3">
              <div className="rounded-xl overflow-hidden border border-black/[0.08] dark:border-white/[0.08]">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-black/40 border-b border-white/5">
                  <span
                    className={
                      "w-2 h-2 rounded-full " +
                      (isUploading
                        ? "bg-blue-500 animate-pulse"
                        : isFresh
                        ? "bg-green-500"
                        : "bg-neutral-400")
                    }
                  />
                  <span className="text-[11px] text-neutral-400 font-mono">
                    runpodctl
                  </span>
                </div>
                <XTermPanel ref={termRef} />
              </div>
              {error && (
                <div className="text-xs text-red-500">
                  <div className="font-medium">{t("ds.upload.failed")}</div>
                  <Mono>{error}</Mono>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {selectedId &&
        apiKey &&
        podReady &&
        sshOk &&
        uploaded &&
        uploaded.hash === project.last_build_hash && (
          <>
            <VideoPromptList
              project={project}
              apiKey={apiKey}
              podId={selectedId}
              onProjectUpdated={() => {
                onProjectReload();
              }}
              refreshKey={captionsRefresh}
            />
            <AutoCaptionBlock
              project={project}
              apiKey={apiKey}
              podId={selectedId}
              onCaptionDone={() => {
                setCaptionsRefresh((x) => x + 1);
                onProjectReload();
              }}
            />
          </>
        )}
    </div>
  );
}
