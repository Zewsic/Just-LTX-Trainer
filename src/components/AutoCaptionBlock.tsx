import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Button, Card, Mono, Pill, Spinner, Textarea } from "./ui";
import XTermPanel, { XTermHandle } from "./XTerm";
import Modal from "./Modal";
import { Project } from "../lib/projects";
import { store } from "../lib/pods";
import { captionKey, testCaptionKey, useTasks } from "../lib/tasks";

interface CaptionStatus {
  state: "pending" | "running" | "done" | "failed";
  exit_code: number | null;
  log_size: number;
}

type Provider = "qwen_omni" | "gemini_flash";

const POLL_RUNNING = 1500;
const POLL_IDLE = 8000;

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
  const [overrideAll, setOverrideAll] = useState(false);
  const [geminiKey, setGeminiKey] = useState<string>("");

  const tasks = useTasks();
  const testing = tasks.isTesting(podId, project.name);

  const [status, setStatus] = useState<CaptionStatus | null>(null);
  const termRef = useRef<XTermHandle>(null);
  const tailPos = useRef(0);
  const reportedRunning = useRef(false);
  const tailBusy = useRef(false);
  const tickBusy = useRef(false);

  const [testError, setTestError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    caption: string;
    clip_filename: string;
    video_url: string;
  } | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  // Загружаем ключ Gemini из настроек
  useEffect(() => {
    (async () => {
      const k = (await store.get<string>("gemini_key")) ?? "";
      setGeminiKey(k);
    })();
  }, []);

  // Первичный опрос состояния — может уже что-то крутится в tmux
  async function fetchStatus() {
    try {
      const s = await invoke<CaptionStatus>("check_caption_state", {
        apiKey,
        podId,
        projectName: project.name,
      });
      setStatus(s);
      return s;
    } catch (e: any) {
      console.error("caption state error", e);
      return null;
    }
  }

  async function pumpTail() {
    if (tailBusy.current) return;
    tailBusy.current = true;
    try {
      const r = await invoke<{ total: number; content: string }>(
        "tail_caption_log",
        {
          apiKey,
          podId,
          projectName: project.name,
          since: tailPos.current,
        },
      );
      if (r.content) termRef.current?.write(r.content);
      tailPos.current = r.total;
    } catch {
      /* noop */
    } finally {
      tailBusy.current = false;
    }
  }

  useEffect(() => {
    fetchStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.name, podId]);

  // Терминал тянет лог из глобального буфера TasksProvider'а — переживает
  // переключение вкладок.
  const termKey = testing
    ? testCaptionKey(podId, project.name)
    : captionKey(podId, project.name);
  useEffect(() => {
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
  }, [termKey]);

  // Когда видим running — переходим в режим polling
  useEffect(() => {
    if (status?.state !== "running" && !reportedRunning.current) return;
    if (status?.state === "running") {
      if (!reportedRunning.current) {
        // первый раз — затягиваем хвост лога
        reportedRunning.current = true;
        tailPos.current = Math.max(0, status.log_size - 64 * 1024);
        termRef.current?.reset();
        pumpTail();
      }
    }
    const period =
      status?.state === "running" ? POLL_RUNNING : POLL_IDLE;
    const id = window.setInterval(async () => {
      if (tickBusy.current) return;
      tickBusy.current = true;
      try {
        const s = await fetchStatus();
        if (s?.state === "running") {
          await pumpTail();
        } else if (s?.state === "done" || s?.state === "failed") {
          // дотянуть хвост
          await pumpTail();
          window.clearInterval(id);
          if (s.state === "done") onCaptionDone?.();
        }
      } finally {
        tickBusy.current = false;
      }
    }, period);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.state]);

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
      gemini_api_key: geminiKey || null,
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
    termRef.current?.reset();
    tailPos.current = 0;
    reportedRunning.current = false;
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
          audio: !!project.audio,
          gemini_api_key: geminiKey || null,
          override_all: overrideAll,
        },
      });
      await fetchStatus();
    } catch (e: any) {
      console.error(e);
      setStatus({
        state: "failed",
        exit_code: null,
        log_size: 0,
      });
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

  const running = status?.state === "running";
  const showTerminal =
    running || status?.state === "done" || status?.state === "failed" || testing;
  const geminiAvailable = !!geminiKey.trim();

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
            <div className="inline-flex rounded-lg bg-black/[0.05] dark:bg-white/[0.06] p-0.5 text-xs">
              <ProviderTab
                active={provider === "qwen_omni"}
                onClick={() => setProvider("qwen_omni")}
                title={t("ds.caption.provider_qwen")}
              />
              <ProviderTab
                active={provider === "gemini_flash"}
                onClick={() =>
                  geminiAvailable && setProvider("gemini_flash")
                }
                title={
                  geminiAvailable
                    ? t("ds.caption.provider_gemini")
                    : t("ds.caption.provider_gemini_no_key")
                }
                disabled={!geminiAvailable}
              />
            </div>
            <div className="text-[11px] text-neutral-500 mt-1.5">
              {provider === "qwen_omni"
                ? t("ds.caption.provider_qwen_hint")
                : t("ds.caption.provider_gemini_hint")}
            </div>
          </div>

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
            <Pill>
              {project.audio
                ? t("ds.caption.audio_on")
                : t("ds.caption.audio_off")}
            </Pill>
            <div className="flex-1" />
            <Button variant="ghost" onClick={runTest} disabled={testing}>
              {testing ? (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner /> {t("ds.caption.testing")}
                </span>
              ) : (
                t("ds.caption.test")
              )}
            </Button>
            <Button onClick={run} disabled={testing}>
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
        <div className="text-xs text-neutral-500 flex items-center gap-2 mb-3">
          <Spinner />
          <span>
            {t("ds.caption.running")} {t("ds.caption.long_hint")}
          </span>
        </div>
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

function ProviderTab({
  active,
  onClick,
  title,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={
        "px-3 py-1.5 rounded-md transition " +
        (active
          ? "bg-white dark:bg-white/[0.12] shadow-sm font-medium"
          : "text-neutral-500 hover:text-current") +
        (disabled ? " opacity-50 cursor-not-allowed" : "")
      }
    >
      {title}
    </button>
  );
}

