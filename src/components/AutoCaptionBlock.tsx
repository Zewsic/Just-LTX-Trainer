import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Button, Card, Mono, Pill, ProgressBar, Spinner, Textarea, Toggle } from "./ui";
import XTermPanel, { XTermHandle } from "./XTerm";
import Modal from "./Modal";
import { GpuStats } from "./GpuStat";
import { Project } from "../lib/projects";
import {
  captionKey,
  testCaptionKey,
  useCaptionStatus,
  useLiveProgress,
  useNvidia,
  useTasks,
} from "../lib/tasks";

type Provider = "qwen_omni" | "gemini_flash" | "single";

export default function AutoCaptionBlock({
  project,
  apiKey,
  podId,
  onCaptionDone,
}: {
  project: Project;
  apiKey: string;
  podId: string;
  onCaptionDone?: () => void;
}) {
  const { t } = useTranslation();
  const tasks = useTasks();

  const total = project.videos.length;
  const missing = useMemo(
    () => project.videos.filter((v) => !v.prompt || !v.prompt.trim()).length,
    [project.videos],
  );
  const allDone = total > 0 && missing === 0;

  const [provider, setProvider] = useState<Provider>("qwen_omni");
  const [instructions, setInstructions] = useState(
    "Provide only the final prompt, without any tags or explanations.",
  );
  const [singleCaption, setSingleCaption] = useState("");
  const [overrideAll, setOverrideAll] = useState(false);

  const status = useCaptionStatus(podId, project.name);
  const testing = tasks.isTesting(podId, project.name);
  const nvidia = useNvidia(podId);
  const captionLogKey = captionKey(podId, project.name);
  const captionProgress = useLiveProgress(captionLogKey, "caption");

  const termRef = useRef<XTermHandle>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    caption: string;
    clip_filename: string;
    video_url: string;
  } | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  // Уведомить родителя когда состояние стало done.
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (status?.state === "running") wasRunningRef.current = true;
    if (status?.state === "done" && wasRunningRef.current) {
      wasRunningRef.current = false;
      onCaptionDone?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.state]);

  // Подписка терминала на лог captioning или test.
  // Панель XTerm рендерится только когда есть что показывать → завязываем
  // эффект и на видимость, иначе ref на первом рендере null и подписка
  // не ставится.
  const termKey = testing
    ? testCaptionKey(podId, project.name)
    : captionLogKey;
  const running = status?.state === "running";
  const showTerminal =
    running || status?.state === "done" || status?.state === "failed" || testing;
  useEffect(() => {
    if (!showTerminal) return;
    const term = termRef.current;
    if (!term) return;
    term.reset();
    const init = tasks.getLog(termKey);
    if (init) term.write(init);
    const unsub = tasks.subscribeLog(termKey, (chunk) => {
      if (chunk === "\x1b[2J\x1b[H") term.reset();
      else term.write(chunk);
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termKey, showTerminal]);

  function closeTestModal() {
    setTestResult(null);
    setTestError(null);
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }

  async function runTest() {
    setTestError(null);
    closeTestModal();
    const r = await tasks.startTestCaption({
      api_key: apiKey,
      pod_id: podId,
      project_name: project.name,
      provider,
      instructions: instructions.trim() || null,
      audio: !!project.audio,
      gemini_api_key: tasks.geminiKey || null,
    });
    if (!r.ok) {
      setTestError(r.error ?? "test failed");
      return;
    }
    const result = tasks.takeTestResult(podId, project.name);
    if (result && result.video_b64 && result.video_mime) {
      const bytes = Uint8Array.from(atob(result.video_b64), (c) =>
        c.charCodeAt(0),
      );
      const blob = new Blob([bytes], { type: result.video_mime });
      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;
      setTestResult({
        caption: result.caption,
        clip_filename: result.clip_filename,
        video_url: url,
      });
    }
  }

  async function run() {
    if (provider === "single" && !singleCaption.trim()) {
      termRef.current?.write(
        "error: " + (t("ds.caption.single_empty") as string) + "\r\n",
      );
      return;
    }
    if (status?.state === "done" || status?.state === "failed") {
      try {
        await invoke("reset_caption", {
          apiKey,
          podId,
          projectName: project.name,
        });
      } catch {
        /* noop */
      }
    }
    try {
      await invoke("start_caption", {
        args: {
          api_key: apiKey,
          pod_id: podId,
          project_name: project.name,
          provider,
          instructions: instructions.trim() || null,
          single_caption:
            provider === "single" ? singleCaption.trim() || null : null,
          audio: !!project.audio,
          gemini_api_key: tasks.geminiKey || null,
          override_all: overrideAll,
        },
      });
      tasks.refresh();
    } catch (e: any) {
      console.error(e);
      termRef.current?.write("error: " + String(e) + "\r\n");
    }
  }

  if (total === 0) return null;

  if (allDone && status?.state !== "running" && status?.state !== "done") {
    return (
      <Card title={t("ds.caption.title")}>
        <Pill tone="ok">✓ {t("ds.caption.all_done")}</Pill>
      </Card>
    );
  }

  const geminiAvailable = !!tasks.geminiKey.trim();

  return (
    <Card title={t("ds.caption.title")}>
      <p className="text-sm text-neutral-500 mb-4">{t("ds.caption.intro")}</p>

      {!allDone && (
        <div className="mb-4">
          <Pill tone="info">
            {t("ds.caption.missing", { n: missing, total })}
          </Pill>
        </div>
      )}

      {!running && (
        <div className="space-y-4">
          <div>
            <div className="text-xs text-neutral-500 mb-1.5">
              {t("ds.caption.provider")}
            </div>
            <Toggle<Provider>
              size="sm"
              value={provider}
              onChange={setProvider}
              items={[
                { id: "qwen_omni", label: t("ds.caption.provider_qwen") },
                {
                  id: "gemini_flash",
                  label: geminiAvailable
                    ? t("ds.caption.provider_gemini")
                    : t("ds.caption.provider_gemini_no_key"),
                  disabled: !geminiAvailable,
                },
                { id: "single", label: t("ds.caption.provider_single") },
              ]}
            />
            <div className="text-[11px] text-neutral-500 mt-1.5">
              {provider === "qwen_omni"
                ? t("ds.caption.provider_qwen_hint")
                : provider === "gemini_flash"
                ? t("ds.caption.provider_gemini_hint")
                : t("ds.caption.provider_single_hint")}
            </div>
          </div>

          {provider === "single" ? (
            <div>
              <div className="text-xs text-neutral-500 mb-1.5">
                {t("ds.caption.single_caption")}
              </div>
              <Textarea
                rows={3}
                value={singleCaption}
                onChange={(e) => setSingleCaption(e.target.value)}
                placeholder={t("ds.caption.single_placeholder")}
              />
            </div>
          ) : (
            <div>
              <div className="text-xs text-neutral-500 mb-1.5">
                {t("ds.caption.instructions")}
              </div>
              <Textarea
                rows={3}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder={t("ds.caption.instructions_placeholder")}
              />
            </div>
          )}

          <label className="flex items-start gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={overrideAll}
              onChange={(e) => setOverrideAll(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-blue-500"
            />
            <div className="flex-1 min-w-0">
              <div className="text-sm">{t("ds.caption.override")}</div>
              <div className="text-[11px] text-neutral-500 mt-0.5">
                {t("ds.caption.override_hint")}
              </div>
            </div>
          </label>

          <div className="flex items-center gap-3">
            {provider !== "single" && (
              <Pill>
                {project.audio
                  ? t("ds.caption.audio_on")
                  : t("ds.caption.audio_off")}
              </Pill>
            )}
            <div className="flex-1" />
            {provider !== "single" && (
              <Button variant="ghost" onClick={runTest} disabled={testing}>
                {testing ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Spinner /> {t("ds.caption.testing")}
                  </span>
                ) : (
                  t("ds.caption.test")
                )}
              </Button>
            )}
            <Button
              onClick={run}
              disabled={
                testing || (provider === "single" && !singleCaption.trim())
              }
            >
              {t("ds.caption.run")}
            </Button>
          </div>
          {testError && (
            <div className="mt-2">
              <Mono>{testError}</Mono>
            </div>
          )}
        </div>
      )}

      {running && (
        <ProgressBar
          pct={captionProgress?.pct ?? null}
          tone="info"
          label={t("ds.caption.running")}
          value={captionProgress?.label ?? t("ds.caption.long_hint")}
          className="mb-3"
        />
      )}

      {status?.state === "done" && (
        <div className="mb-3">
          <Pill tone="ok">✓ {t("ds.caption.done_title")}</Pill>
          <p className="text-xs text-neutral-500 mt-1.5">
            {t("ds.caption.done_hint")}
          </p>
        </div>
      )}

      {status?.state === "failed" && (
        <div className="mb-3 text-xs text-red-500">
          <div className="font-medium">{t("ds.caption.failed")}</div>
        </div>
      )}

      {showTerminal && (
        <div className="mt-3 rounded-xl overflow-hidden border border-black/[0.08] dark:border-white/[0.08]">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-black/40 border-b border-white/5">
            <span
              className={
                "w-2 h-2 rounded-full " +
                (testing || running
                  ? "bg-blue-500 animate-pulse"
                  : status?.state === "done"
                  ? "bg-green-500"
                  : status?.state === "failed"
                  ? "bg-red-500"
                  : "bg-neutral-400")
              }
            />
            <span className="text-[11px] text-neutral-400 font-mono">
              {testing ? "test" : `tmux: ltx_cap_${project.name}`}
            </span>
          </div>
          <XTermPanel ref={termRef} />
        </div>
      )}

      {(running || testing) && (
        <div className="mt-4">
          <GpuStats nvidia={nvidia} loadingLabel={t("detail.live_loading")} />
        </div>
      )}

      <Modal
        open={!!testResult}
        onClose={closeTestModal}
        title={t("ds.caption.test_title")}
        width="max-w-2xl"
        footer={
          <Button onClick={closeTestModal}>{t("ds.caption.test_close")}</Button>
        }
      >
        {testResult && (
          <div className="space-y-4">
            <div>
              <div className="text-xs text-neutral-500 mb-1.5">
                {t("ds.caption.test_clip_label")}
              </div>
              <video
                src={testResult.video_url}
                controls
                autoPlay
                loop
                muted
                className="w-full rounded-xl bg-black max-h-[50vh]"
              />
              <div className="text-[11px] text-neutral-500 font-mono mt-1.5">
                {testResult.clip_filename}
              </div>
            </div>
            <div>
              <div className="text-xs text-neutral-500 mb-1.5">
                {t("ds.caption.test_caption_label")}
              </div>
              <div className="rounded-lg bg-black/[0.04] dark:bg-white/[0.05] p-3 text-sm whitespace-pre-wrap">
                {testResult.caption || "—"}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
}
