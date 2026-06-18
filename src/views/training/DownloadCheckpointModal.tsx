import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button, Mono, Pill, ProgressBar, Spinner } from "../../components/ui";
import Modal from "../../components/Modal";

interface SendState {
  state: "pending" | "running" | "done" | "failed";
  log_size: number;
  code: string | null;
  log_tail: string;
}

/**
 * Скачивание чекпоинта в две стадии:
 *
 *  1. На поде запускаем `runpodctl send <ckpt>` в tmux'е и тянем код.
 *  2. Пользователь выбирает:
 *     • «Сохранить в загрузки» — локально вызываем `runpodctl receive <code>`
 *       в `~/Downloads`. Лог стримим в консоль.
 *     • «Скопировать»          — кладём код в буфер обмена и закрываем
 *       модалку (pod-side send продолжит жить пока кто-то не приёмет).
 *
 *  При закрытии модалки без «Сохранить» — убиваем pod-side send, чтобы не
 *  висел зря.
 */
export default function DownloadCheckpointModal({
  apiKey,
  podId,
  projectName,
  step,
  onClose,
}: {
  apiKey: string;
  podId: string;
  projectName: string;
  step: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [send, setSend] = useState<SendState | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [recvLines, setRecvLines] = useState<string[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [downloadedTo, setDownloadedTo] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);
  const codeReceivedRef = useRef(false);

  // 1. Старт pod-side runpodctl send.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    (async () => {
      try {
        await invoke("checkpoint_send_start", {
          apiKey,
          podId,
          projectName,
          step,
        });
      } catch (e: any) {
        setError(String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2. Polling состояния send.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await invoke<SendState>("checkpoint_send_state", {
          apiKey,
          podId,
          projectName,
          step,
        });
        if (cancelled) return;
        setSend(s);
        if (s.log_tail) {
          // Обновляем консоль целиком (tail возвращает всё с начала).
          setLogLines(
            s.log_tail
              .split(/\r?\n/)
              .map((l) => l.replace(/\r/g, ""))
              .filter((l) => l.length > 0),
          );
        }
        // Когда код пришёл первый раз — отметим, чтобы дальше не «терять» его
        // в стейте даже если runpodctl что-то ещё допишет.
        if (s.code && !codeReceivedRef.current) {
          codeReceivedRef.current = true;
        }
      } catch (e: any) {
        if (!cancelled) setError(String(e));
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 3. Слушаем лог локального receive.
  useEffect(() => {
    let unl: (() => void) | undefined;
    let alive = true;
    listen<{ line: string }>("ckpt_receive:log", (e) => {
      setRecvLines((prev) => [...prev, e.payload.line]);
    }).then((u) => {
      if (!alive) u();
      else unl = u;
    });
    return () => {
      alive = false;
      unl?.();
    };
  }, []);

  // 4. При размонтировании — убиваем pod-side send (если ещё не done).
  useEffect(() => {
    return () => {
      invoke("checkpoint_send_stop", {
        apiKey,
        podId,
        projectName,
        step,
      }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function doCopy() {
    if (!send?.code) return;
    try {
      await navigator.clipboard.writeText(send.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }

  async function doSaveLocal() {
    if (!send?.code || downloading) return;
    setDownloading(true);
    setRecvLines([]);
    setError(null);
    try {
      const dest = await invoke<string>("runpodctl_receive_local", {
        code: send.code,
      });
      setDownloadedTo(dest);
    } catch (e: any) {
      setError(String(e));
    } finally {
      setDownloading(false);
    }
  }

  const code = send?.code ?? null;
  const isPending = send?.state === "running" && !code;
  const isReady = !!code && !downloading && !downloadedTo;
  const allLog = [...logLines, ...recvLines].slice(-200);

  return (
    <Modal
      open
      onClose={onClose}
      title={t("tr.validation.download_title", { step })}
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {downloadedTo ? t("common.ok") : t("common.cancel")}
          </Button>
          {code && (
            <>
              <Button variant="ghost" onClick={doCopy}>
                {copied
                  ? "✓ " + t("tr.validation.copied")
                  : t("tr.validation.copy_code")}
              </Button>
              <Button onClick={doSaveLocal} disabled={downloading}>
                {downloading ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Spinner /> …
                  </span>
                ) : (
                  t("tr.validation.save_local")
                )}
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="space-y-3">
        {error && (
          <div className="text-xs text-red-500">
            <Mono>{error}</Mono>
          </div>
        )}

        {isPending && (
          <ProgressBar
            tone="info"
            label={
              <span className="inline-flex items-center gap-1.5">
                <Spinner /> {t("tr.validation.download_starting")}
              </span>
            }
            value={null}
          />
        )}

        {code && (
          <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-4">
            <div className="text-[11px] uppercase tracking-wider text-blue-700 dark:text-blue-300 mb-1.5">
              {t("tr.validation.code_ready")}
            </div>
            <div className="font-mono text-sm break-all select-all">{code}</div>
            {isReady && (
              <div className="text-[11px] text-neutral-500 mt-2">
                {t("tr.validation.code_hint")}
              </div>
            )}
          </div>
        )}

        {downloadedTo && (
          <Pill tone="ok">
            ✓ {t("tr.validation.saved_to", { path: downloadedTo })}
          </Pill>
        )}

        {allLog.length > 0 && (
          <Mono>{allLog.join("\n")}</Mono>
        )}
      </div>
    </Modal>
  );
}
