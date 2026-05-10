import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Button, Card, Mono, Pill, Select, Spinner } from "../../components/ui";
import XTermPanel, { XTermHandle } from "../../components/XTerm";
import AutoCaptionBlock from "../../components/AutoCaptionBlock";
import VideoPromptList from "../../components/VideoPromptList";
import {
  checkLocalTools,
  installRunpodctl,
  LocalTools,
  Project,
} from "../../lib/projects";
import {
  loadManaged,
  ManagedPod,
  Pod,
  store,
} from "../../lib/pods";
import { uploadKey, useTasks } from "../../lib/tasks";
import { parseProgress, Progress } from "../../lib/progress";

interface SshProbe {
  ok: boolean;
  host: string;
  port: number;
  user: string;
  key_used: string | null;
  error: string | null;
}


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
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [managed, setManaged] = useState<ManagedPod[]>([]);
  const [livePods, setLivePods] = useState<Record<string, Pod>>({});
  const [selectedId, setSelectedId] = useState<string>("");
  const [probe, setProbe] = useState<SshProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [tools, setTools] = useState<LocalTools | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [captionsRefresh, setCaptionsRefresh] = useState(0);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [phase, setPhase] = useState<string | null>(null);

  const tasks = useTasks();

  const termRef = useRef<XTermHandle>(null);
  const apiKeyRef = useRef<string | null>(null);

  // Load on mount
  useEffect(() => {
    (async () => {
      const k = (await store.get<string>("runpod_key")) ?? "";
      setApiKey(k || null);
      apiKeyRef.current = k || null;
      const all = await loadManaged();
      setManaged(all);
      // подгружаем актуальные данные о подах
      if (k) {
        try {
          const pods = await invoke<Pod[]>("list_pods", { apiKey: k });
          const map: Record<string, Pod> = {};
          for (const p of pods) map[p.id] = p;
          setLivePods(map);
        } catch {
          /* noop */
        }
      }
      // выбираем по умолчанию: первый ready, иначе первый из всех
      const preferred =
        all.find((m) => m.ltx_state !== "init")?.id ?? all[0]?.id ?? "";
      setSelectedId(preferred);
      // tools
      try {
        setTools(await checkLocalTools());
      } catch {
        /* noop */
      }
    })();
  }, []);

  const selectedManaged = useMemo(
    () => managed.find((m) => m.id === selectedId) ?? null,
    [managed, selectedId],
  );
  const selectedLive = useMemo(
    () => livePods[selectedId] ?? null,
    [livePods, selectedId],
  );

  // SSH probe для выбранного пода
  useEffect(() => {
    if (!apiKey || !selectedId) {
      setProbe(null);
      return;
    }
    runProbe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, selectedId]);

  async function runProbe() {
    if (!apiKeyRef.current || !selectedId || probing) return;
    setProbing(true);
    try {
      const r = await invoke<SshProbe>("pod_ssh_probe", {
        apiKey: apiKeyRef.current,
        podId: selectedId,
      });
      setProbe(r);
    } catch (e: any) {
      setProbe({
        ok: false,
        host: "",
        port: 0,
        user: selectedId,
        key_used: null,
        error: String(e),
      });
    } finally {
      setProbing(false);
    }
  }

  async function refreshTools() {
    try {
      setTools(await checkLocalTools());
    } catch {
      /* noop */
    }
  }

  async function doInstallRunpodctl() {
    setInstalling(true);
    setInstallLog(null);
    try {
      const out = await installRunpodctl();
      setInstallLog(out);
      await refreshTools();
    } catch (e: any) {
      setInstallLog(String(e));
    } finally {
      setInstalling(false);
    }
  }

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

  // Подписка терминала на буфер задачи (выживает переключение вкладок).
  // Важно: панель XTerm условно-рендерится (см. ниже), поэтому подписку
  // нужно (пере)ставить когда панель реально появилась — гейтим эффект
  // по тем же условиям, что и рендер панели.
  const uploadLogKey = selectedId ? uploadKey(selectedId, project.name) : null;
  const isUploadingNow =
    !!selectedId && tasks.isUploading(selectedId, project.name);
  const hasUploadLog =
    !!uploadLogKey && tasks.getLog(uploadLogKey).length > 0;
  const termVisible = isUploadingNow || hasUploadLog;
  useEffect(() => {
    if (!uploadLogKey || !termVisible) return;
    const t = termRef.current;
    if (!t) return;
    t.reset();
    const initial = tasks.getLog(uploadLogKey);
    if (initial) t.write(initial);
    const unsub = tasks.subscribeLog(uploadLogKey, (chunk) => {
      if (chunk === "\x1b[2J\x1b[H") {
        t.reset();
      } else {
        t.write(chunk);
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadLogKey, termVisible]);

  // Парс прогресса/фазы из лог-буфера на каждый chunk.
  useEffect(() => {
    if (!uploadLogKey) {
      setProgress(null);
      setPhase(null);
      return;
    }
    const recompute = () => {
      const log = tasks.getLog(uploadLogKey);
      setProgress(parseProgress("upload", log));
      const phaseMatches = [...log.matchAll(/# phase: (\w+)/g)];
      const last = phaseMatches[phaseMatches.length - 1];
      setPhase(last ? last[1] : null);
    };
    recompute();
    const unsub = tasks.subscribeLog(uploadLogKey, () => recompute());
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadLogKey]);

  // Decide UI state
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
  const isUploading = isUploadingNow;
  const isBusy = isUploading;
  const isFresh = !!uploaded && uploaded.hash === project.last_build_hash;
  const canUpload =
    podRunning &&
    podReady &&
    sshOk &&
    tools?.has_runpodctl &&
    !isUploading;

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
              disabled={isBusy}
            >
              {managed.map((m) => {
                const live = livePods[m.id];
                const gpu = live?.gpu_display_name ?? "—";
                const count = live?.gpu_count ? ` ×${live.gpu_count}` : "";
                const phase =
                  live?.desired_status === "EXITED" ||
                  live?.desired_status === "TERMINATED"
                    ? "stopped"
                    : live?.desired_status !== "RUNNING"
                    ? "starting"
                    : m.ltx_state === "init"
                    ? "needs setup"
                    : "ready";
                return (
                  <option key={m.id} value={m.id}>
                    {(m.name || m.id) + " · " + gpu + count + " · " + phase}
                  </option>
                );
              })}
            </Select>
          </div>

          {selectedManaged && (
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
              <Row k="GPU" v={selectedLive?.gpu_display_name ?? "—"} />
              <Row k="Status" v={podStatus.toLowerCase()} mono />
              <Row k="ltx_state" v={selectedManaged.ltx_state} mono />
              <Row
                k="SSH"
                v={
                  probe === null
                    ? t("ds.upload.checking_ssh")
                    : sshOk
                    ? `${probe.user}@${probe.host}:${probe.port}`
                    : t("ds.upload.needs_ssh")
                }
                mono
              />
            </div>
          )}

          {!podRunning ? (
            <Pill tone="warn">{t("ds.upload.needs_running")}</Pill>
          ) : !podReady ? (
            <Pill tone="warn">{t("ds.upload.needs_init")}</Pill>
          ) : probe === null ? (
            <Pill tone="neutral">
              <Spinner /> {t("ds.upload.checking_ssh")}
            </Pill>
          ) : !sshOk ? (
            <div className="flex items-center gap-2 flex-wrap">
              <Pill tone="err">{t("ds.upload.needs_ssh")}</Pill>
              {!probing && (
                <Button variant="ghost" size="sm" onClick={runProbe}>
                  ↻ {t("common.retry")}
                </Button>
              )}
              {probe.error && (
                <span className="text-xs text-neutral-500 truncate">
                  {probe.error}
                </span>
              )}
            </div>
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
              onClick={doInstallRunpodctl}
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
              {isBusy ? (
                <ProgressButton
                  pct={progress?.pct ?? 0}
                  phase={phase}
                  progressLabel={progress?.label ?? null}
                />
              ) : (
                <Button onClick={doUpload} disabled={!canUpload}>
                  {isFresh
                    ? t("ds.upload.reupload")
                    : t("ds.upload.upload")}
                </Button>
              )}
              {isFresh && !isBusy && (
                <Button variant="ghost" onClick={onGoTraining}>
                  {t("tr.go_training")}
                </Button>
              )}
            </div>
          </div>

          {(isBusy || tasks.getLog(uploadLogKey ?? "").length > 0) && (
            <div className="mt-4 space-y-3">
              <div className="rounded-xl overflow-hidden border border-black/[0.08] dark:border-white/[0.08]">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-black/40 border-b border-white/5">
                  <span
                    className={
                      "w-2 h-2 rounded-full " +
                      (isBusy
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

      {/* Список видео + импорт промптов с пода + авто-кепшен —
          только когда на сервер залит актуальный билд */}
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

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-neutral-500">{k}</span>
      <span className={"truncate " + (mono ? "font-mono" : "")}>{v}</span>
    </div>
  );
}

function ProgressButton({
  pct,
  phase,
  progressLabel,
}: {
  pct: number;
  phase: string | null;
  progressLabel: string | null;
}) {
  const phaseLabel: Record<string, string> = {
    bootstrap: "подготовка",
    send_starting: "запуск",
    transferring: "передача",
    extracting: "распаковка",
  };
  const headline = progressLabel
    ? `${pct.toFixed(0)}% · ${progressLabel}`
    : (phase && phaseLabel[phase]) || "загрузка…";
  const fill = Math.max(0, Math.min(100, pct));
  return (
    <div className="relative overflow-hidden rounded-lg bg-blue-500/20 text-blue-700 dark:text-blue-300 px-4 py-2 text-sm font-medium min-w-[180px]">
      <div
        className="absolute inset-y-0 left-0 bg-blue-500/40 transition-[width]"
        style={{ width: `${fill}%` }}
      />
      <span className="relative inline-flex items-center gap-2 whitespace-nowrap">
        <Spinner /> {headline}
      </span>
    </div>
  );
}
