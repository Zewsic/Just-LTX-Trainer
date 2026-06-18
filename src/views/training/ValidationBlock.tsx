import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Button, Card, Pill, Spinner, Toggle } from "../../components/ui";
import Modal from "../../components/Modal";
import DownloadCheckpointModal from "./DownloadCheckpointModal";

interface ValidationItem {
  index: number;
  video: string | null;
  image: string | null;
  prompt: string | null;
}

interface CheckpointInfo {
  step: number;
  size_bytes: number;
  path: string;
}

export default function ValidationBlock({
  apiKey,
  podId,
  projectName,
  completedSteps,
  prompts = [],
  trigger = "",
  mode = "live",
}: {
  apiKey: string;
  podId: string;
  projectName: string;
  /** Шаги, на которых валидация уже завершилась — приходят из TrainingState. */
  completedSteps: number[];
  /** Оригинальные промпты валидации (без trigger). Сэмплы 1..N матчатся по индексу. */
  prompts?: string[];
  /** Триггер LoRA для отображения как пилюля. */
  trigger?: string;
  /** "live" — гейтим выбор по completedSteps; "history" — все на диске активны. */
  mode?: "live" | "history";
}) {
  const { t } = useTranslation();
  const [steps, setSteps] = useState<number[]>([]);
  const [activeStep, setActiveStep] = useState<number | null>(null);
  const [items, setItems] = useState<ValidationItem[] | null>(null);
  const [checkpoint, setCheckpoint] = useState<CheckpointInfo | null>(null);
  const [loading, setLoading] = useState(false);

  // Если бэкенд показал, что есть новые шаги — обновляем список.
  // На случай если файлы уже лежат на поде (возврат после рестарта) — также
  // дёргаем list_validation_steps.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await invoke<number[]>("list_validation_steps", {
          apiKey,
          podId,
          projectName,
        });
        if (!cancelled) {
          // объединяем с completedSteps на случай задержки между маркером
          // и появлением каталога.
          const merged = Array.from(new Set([...r, ...completedSteps])).sort(
            (a, b) => a - b,
          );
          setSteps(merged);
          if (activeStep == null && merged.length > 0) {
            setActiveStep(merged[merged.length - 1]);
          }
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, podId, projectName, completedSteps.length]);

  // Файлы текущего шага.
  useEffect(() => {
    if (activeStep == null) {
      setItems(null);
      setCheckpoint(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [files, ckpt] = await Promise.all([
          invoke<ValidationItem[]>("list_validation_files", {
            apiKey,
            podId,
            projectName,
            step: activeStep,
          }),
          invoke<CheckpointInfo | null>("checkpoint_info", {
            apiKey,
            podId,
            projectName,
            step: activeStep,
          }),
        ]);
        if (!cancelled) {
          setItems(files);
          setCheckpoint(ckpt);
        }
      } catch {
        if (!cancelled) {
          setItems([]);
          setCheckpoint(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeStep, apiKey, podId, projectName]);

  const [viewer, setViewer] = useState<ValidationItem | null>(null);
  const [downloadOpen, setDownloadOpen] = useState(false);

  // Промпт берём из cfg по 1-based индексу. Если индекс выходит за границы —
  // null. Триггер не клеим в строку, передадим отдельно для отрисовки пилюлей.
  function promptForIndex(idx: number): string | null {
    const i = idx - 1;
    if (i < 0 || i >= prompts.length) return null;
    return prompts[i] ?? null;
  }

  const toggleItems = useMemo(
    () =>
      steps.map((s) => ({
        id: String(s),
        label: s.toLocaleString(),
        disabled: mode === "live" ? !completedSteps.includes(s) : false,
      })),
    [steps, completedSteps, mode],
  );

  // В history-режиме нечего показывать без чекпоинтов — просто скрываем блок.
  if (steps.length === 0) {
    if (mode === "history") return null;
    return (
      <Card title={t("tr.validation.label")}>
        <p className="text-sm text-neutral-500">{t("tr.validation.no_steps")}</p>
      </Card>
    );
  }

  const cardTitle =
    mode === "history" ? t("tr.validation.last_result") : t("tr.validation.label");

  return (
    <>
      <Card title={cardTitle}>
        <div className="space-y-4">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-1.5">
              {t("tr.validation.step_selector")}
            </div>
            <Toggle<string>
              size="sm"
              value={activeStep != null ? String(activeStep) : ""}
              onChange={(v) => setActiveStep(parseInt(v, 10))}
              items={toggleItems}
            />
          </div>

          {loading ? (
            <p className="text-sm text-neutral-500 flex items-center gap-2">
              <Spinner /> …
            </p>
          ) : items && items.length > 0 ? (
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {items.map((it) => (
                <ItemCard
                  key={it.index}
                  item={it}
                  prompt={promptForIndex(it.index)}
                  trigger={trigger}
                  onOpen={() => setViewer({ ...it, prompt: promptForIndex(it.index) })}
                />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-neutral-500">
              {t("tr.validation.no_files")}
            </p>
          )}

          <div className="flex items-center gap-3 pt-2 border-t border-black/[0.06] dark:border-white/[0.08]">
            <div className="flex-1 min-w-0">
              <div className="text-[11px] text-neutral-500">
                {t("tr.validation.checkpoint_size")}
              </div>
              <div className="text-sm font-mono">
                {checkpoint
                  ? formatBytes(checkpoint.size_bytes)
                  : "—"}
              </div>
            </div>
            <Button
              size="sm"
              disabled={!checkpoint}
              onClick={() => setDownloadOpen(true)}
            >
              {t("tr.validation.download")}
            </Button>
          </div>
        </div>
      </Card>

      {viewer && activeStep != null && (
        <ViewerModal
          apiKey={apiKey}
          podId={podId}
          projectName={projectName}
          step={activeStep}
          item={viewer}
          trigger={trigger}
          onClose={() => setViewer(null)}
        />
      )}

      {downloadOpen && activeStep != null && checkpoint && (
        <DownloadCheckpointModal
          apiKey={apiKey}
          podId={podId}
          projectName={projectName}
          step={activeStep}
          onClose={() => setDownloadOpen(false)}
        />
      )}
    </>
  );
}

function ItemCard({
  item,
  prompt,
  trigger,
  onOpen,
}: {
  item: ValidationItem;
  prompt: string | null;
  trigger: string;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        onClick={onOpen}
        className="w-full text-left p-3 rounded-xl border border-black/[0.06] dark:border-white/[0.1] hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition flex items-center gap-3"
      >
        <span className="w-10 h-10 rounded-lg bg-black/[0.05] dark:bg-white/[0.06] flex items-center justify-center text-xs font-mono text-neutral-500 shrink-0">
          #{item.index}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-1">
            {item.video && <Pill tone="info">video</Pill>}
            {item.image && <Pill tone="info">image</Pill>}
          </div>
          {prompt && (
            <div className="text-xs text-neutral-700 dark:text-neutral-300 line-clamp-2 italic">
              {trigger && (
                <span className="not-italic px-1 py-0 mr-1 rounded bg-blue-500/15 text-blue-700 dark:text-blue-300 font-mono text-[10px]">
                  {trigger}
                </span>
              )}
              {prompt}
            </div>
          )}
        </div>
      </button>
    </li>
  );
}

function ViewerModal({
  apiKey,
  podId,
  projectName,
  step,
  item,
  trigger,
  onClose,
}: {
  apiKey: string;
  podId: string;
  projectName: string;
  step: number;
  item: ValidationItem;
  trigger: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const blobsRef = useRef<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const fetches: Promise<void>[] = [];
      if (item.video) {
        fetches.push(
          fetchBlob(apiKey, podId, projectName, step, item.video).then((u) => {
            if (cancelled || !u) return;
            blobsRef.current.push(u);
            setVideoUrl(u);
          }),
        );
      }
      if (item.image) {
        fetches.push(
          fetchBlob(apiKey, podId, projectName, step, item.image).then((u) => {
            if (cancelled || !u) return;
            blobsRef.current.push(u);
            setImageUrl(u);
          }),
        );
      }
      await Promise.all(fetches);
    })();
    return () => {
      cancelled = true;
      for (const u of blobsRef.current) URL.revokeObjectURL(u);
      blobsRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.video, item.image, step]);

  return (
    <Modal
      open
      onClose={onClose}
      title={t("tr.validation.viewer_title", {
        step,
        name: item.video ?? item.image ?? `#${item.index}`,
      })}
      width="max-w-4xl"
      footer={<Button onClick={onClose}>{t("common.cancel")}</Button>}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {imageUrl && (
            <img
              src={imageUrl}
              alt=""
              className="w-full rounded-xl bg-black object-contain max-h-[50vh]"
            />
          )}
          {videoUrl ? (
            <video
              src={videoUrl}
              controls
              autoPlay
              loop
              muted
              className={
                "w-full rounded-xl bg-black max-h-[50vh] " +
                (imageUrl ? "" : "md:col-span-2")
              }
            />
          ) : (
            !imageUrl && (
              <div className="flex items-center justify-center text-neutral-500 py-10">
                <Spinner />
              </div>
            )
          )}
        </div>
        {item.prompt && (
          <div className="rounded-lg bg-black/[0.04] dark:bg-white/[0.05] p-3 text-sm whitespace-pre-wrap">
            {trigger && (
              <span className="px-1.5 py-0.5 mr-1.5 rounded-md bg-blue-500/15 text-blue-700 dark:text-blue-300 font-mono text-xs">
                {trigger}
              </span>
            )}
            {item.prompt}
          </div>
        )}
      </div>
    </Modal>
  );
}

async function fetchBlob(
  apiKey: string,
  podId: string,
  projectName: string,
  step: number,
  filename: string,
): Promise<string | null> {
  try {
    const r = await invoke<{ mime: string; b64: string; size: number }>(
      "read_validation_file",
      {
        apiKey,
        podId,
        projectName,
        step,
        filename,
      },
    );
    const bytes = Uint8Array.from(atob(r.b64), (c) => c.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: r.mime }));
  } catch {
    return null;
  }
}

function formatBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GiB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MiB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KiB`;
  return `${b} B`;
}
