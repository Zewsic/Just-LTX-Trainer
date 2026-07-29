import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  Button,
  Card,
  Field,
  Input,
  Pill,
  Select,
  Spinner,
  Textarea,
  Toggle,
} from "../components/ui";
import Modal from "../components/Modal";
import {
  ASPECT_OPTIONS,
  LENGTH_OPTIONS,
  Project,
  basename,
} from "../lib/projects";
import { GenerateJob, useTasks } from "../lib/tasks";

export default function Generate() {
  const { t } = useTranslation();
  const tasks = useTasks();
  const apiKey = tasks.apiKey;
  const managed = tasks.managed;
  const livePods = tasks.pods;
  const projects = tasks.projectList;

  const [podId, setPodId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [project, setProject] = useState<Project | null>(null);

  const [checkpointSteps, setCheckpointSteps] = useState<number[]>([]);
  const [step, setStep] = useState<number | null>(null);
  const [loraWeight, setLoraWeight] = useState(1.0);
  const [mode, setMode] = useState<"t2v" | "i2v">("t2v");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState(
    "worst quality, inconsistent motion, blurry, jittery, distorted, static",
  );
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1_000_000));
  const [aspect, setAspect] = useState<string>(ASPECT_OPTIONS[0]);
  const [length, setLength] = useState<number>(LENGTH_OPTIONS[0]);
  const [inferenceSteps, setInferenceSteps] = useState(30);
  const [formError, setFormError] = useState<string | null>(null);
  const [viewerJob, setViewerJob] = useState<GenerateJob | null>(null);

  useEffect(() => {
    if (!projectName) {
      setProject(null);
      return;
    }
    let cancelled = false;
    tasks.loadProjectByName(projectName).then((p) => {
      if (!cancelled && p) setProject(p);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectName]);

  // список шагов чекпоинтов проекта на выбранном поде
  useEffect(() => {
    if (!apiKey || !podId || !projectName) {
      setCheckpointSteps([]);
      setStep(null);
      return;
    }
    let cancelled = false;
    invoke<number[]>("list_validation_steps", {
      apiKey,
      podId,
      projectName,
    })
      .then((r) => {
        if (cancelled) return;
        setCheckpointSteps(r);
        setStep((prev) => (prev != null && r.includes(prev) ? prev : r[r.length - 1] ?? null));
      })
      .catch(() => {
        if (!cancelled) {
          setCheckpointSteps([]);
          setStep(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiKey, podId, projectName]);

  const trainingBusy = podId ? tasks.isPodTrainingBusy(podId) : false;
  const generateBusy = podId ? tasks.isPodGenerateBusy(podId) : false;

  async function pickImage() {
    const sel = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "webp"] }],
    });
    if (sel && !Array.isArray(sel)) setImagePath(sel);
  }

  function handleEnqueue() {
    setFormError(null);
    if (!apiKey) {
      setFormError(t("gen.error_no_api_key"));
      return;
    }
    if (!podId || !projectName || step == null) {
      setFormError(t("gen.error_missing_selection"));
      return;
    }
    if (!prompt.trim()) {
      setFormError(t("gen.error_missing_prompt"));
      return;
    }
    if (mode === "i2v" && !imagePath) {
      setFormError(t("gen.error_missing_image"));
      return;
    }
    if (trainingBusy) {
      setFormError(t("gen.error_training_busy"));
      return;
    }
    const pod = managed.find((m) => m.id === podId);
    tasks.enqueueGenerate({
      podId,
      podName: pod?.name || podId,
      projectName,
      rank: project?.training.rank ?? 32,
      step,
      loraWeight,
      mode,
      prompt: prompt.trim(),
      negativePrompt: negativePrompt.trim(),
      localImagePath: mode === "i2v" ? imagePath : null,
      seed,
      aspectRatio: aspect,
      lengthSeconds: length,
      inferenceSteps,
    });
  }

  const allJobs = [...tasks.generateQueue].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="space-y-4 max-w-3xl">
      <Card title={t("gen.title")}>
        <div className="space-y-6">
          <div className="flex items-end gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-xs text-neutral-500 mb-1.5">{t("gen.server")}</div>
              <Select value={podId} onChange={(e) => setPodId(e.target.value)}>
                {managed.length === 0 && <option value="">—</option>}
                {!podId && <option value="">—</option>}
                {managed.map((m) => {
                  const live = livePods.get(m.id);
                  const gpu = live?.gpu_display_name ?? "—";
                  return (
                    <option key={m.id} value={m.id}>
                      {(m.name || m.id) + " · " + gpu}
                    </option>
                  );
                })}
              </Select>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs text-neutral-500 mb-1.5">{t("gen.project")}</div>
              <Select value={projectName} onChange={(e) => setProjectName(e.target.value)}>
                {!projectName && <option value="">—</option>}
                {(projects ?? []).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {trainingBusy && (
            <Pill tone="warn">{t("gen.training_busy_hint")}</Pill>
          )}
          {!trainingBusy && generateBusy && (
            <Pill tone="info">{t("gen.generate_busy_hint")}</Pill>
          )}

          {podId && projectName && (
            <>
              <div>
                <div className="text-xs text-neutral-500 mb-1.5">
                  {t("gen.checkpoint")}
                </div>
                {checkpointSteps.length === 0 ? (
                  <p className="text-sm text-neutral-500">{t("gen.no_checkpoints")}</p>
                ) : (
                  <Toggle<string>
                    size="sm"
                    value={step != null ? String(step) : ""}
                    onChange={(v) => setStep(parseInt(v, 10))}
                    items={checkpointSteps.map((s) => ({
                      id: String(s),
                      label: s.toLocaleString(),
                    }))}
                  />
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label={t("gen.lora_weight")}>
                  <Input
                    type="number"
                    min={0}
                    max={2}
                    step={0.05}
                    value={loraWeight}
                    onChange={(e) => setLoraWeight(parseFloat(e.target.value) || 0)}
                  />
                </Field>
                <Field label={t("gen.mode")}>
                  <Toggle<"t2v" | "i2v">
                    value={mode}
                    onChange={setMode}
                    items={[
                      { id: "t2v", label: t("tr.mode.t2v") },
                      { id: "i2v", label: t("tr.mode.i2v") },
                    ]}
                  />
                </Field>
              </div>

              {mode === "i2v" && (
                <div>
                  <div className="text-xs text-neutral-500 mb-1.5">
                    {t("gen.image")}
                  </div>
                  <div className="flex items-center gap-3">
                    <Button size="sm" variant="ghost" onClick={pickImage}>
                      {imagePath ? basename(imagePath) : t("gen.pick_image")}
                    </Button>
                    {imagePath && (
                      <Button size="sm" variant="ghost" onClick={() => setImagePath(null)}>
                        ✕
                      </Button>
                    )}
                  </div>
                </div>
              )}

              <Field label={t("gen.prompt")}>
                <Textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={t("gen.prompt_placeholder")}
                  rows={3}
                />
              </Field>

              <Field label={t("gen.negative_prompt")}>
                <Textarea
                  value={negativePrompt}
                  onChange={(e) => setNegativePrompt(e.target.value)}
                  rows={2}
                />
              </Field>

              <div className="grid grid-cols-3 gap-3">
                <Field label={t("gen.aspect")}>
                  <Toggle<string>
                    size="sm"
                    value={aspect}
                    onChange={setAspect}
                    items={ASPECT_OPTIONS.map((a) => ({ id: a, label: a }))}
                  />
                </Field>
                <Field label={t("gen.length")}>
                  <Toggle<string>
                    size="sm"
                    value={String(length)}
                    onChange={(v) => setLength(parseFloat(v))}
                    items={LENGTH_OPTIONS.map((l) => ({
                      id: String(l),
                      label: `${l}s`,
                    }))}
                  />
                </Field>
                <Field label={t("gen.seed")}>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      value={seed}
                      onChange={(e) => setSeed(parseInt(e.target.value, 10) || 0)}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSeed(Math.floor(Math.random() * 1_000_000))}
                    >
                      🎲
                    </Button>
                  </div>
                </Field>
              </div>

              <div>
                <div className="text-xs text-neutral-500 mb-1.5">
                  {t("gen.inference_steps")}
                </div>
                <div className="flex items-baseline gap-3">
                  <input
                    type="range"
                    min={10}
                    max={60}
                    step={1}
                    value={inferenceSteps}
                    onChange={(e) => setInferenceSteps(parseInt(e.target.value, 10))}
                    className="flex-1 accent-blue-500"
                  />
                  <span className="font-mono text-sm tabular-nums w-10 text-right">
                    {inferenceSteps}
                  </span>
                </div>
              </div>

              {formError && (
                <p className="text-xs text-red-500">{formError}</p>
              )}

              <div className="flex justify-end">
                <Button onClick={handleEnqueue} disabled={trainingBusy}>
                  {t("gen.enqueue")}
                </Button>
              </div>
            </>
          )}
        </div>
      </Card>

      <Card title={t("gen.queue_title")}>
        {allJobs.length === 0 ? (
          <p className="text-sm text-neutral-500">{t("gen.queue_empty")}</p>
        ) : (
          <ul className="-mx-5 divide-y divide-black/[0.05] dark:divide-white/[0.07]">
            {allJobs.map((j) => (
              <GenerateJobRow
                key={j.id}
                job={j}
                onCancel={() => tasks.cancelGenerate(j.id)}
                onView={() => setViewerJob(j)}
              />
            ))}
          </ul>
        )}
      </Card>

      {viewerJob && (
        <GenerateViewerModal
          apiKey={apiKey ?? ""}
          job={viewerJob}
          onClose={() => setViewerJob(null)}
        />
      )}
    </div>
  );
}

function jobStateTone(state: GenerateJob["state"]) {
  switch (state) {
    case "done":
      return "ok" as const;
    case "failed":
      return "err" as const;
    case "running":
    case "uploading_image":
      return "info" as const;
    case "canceled":
      return "neutral" as const;
    default:
      return "neutral" as const;
  }
}

function GenerateJobRow({
  job,
  onCancel,
  onView,
}: {
  job: GenerateJob;
  onCancel: () => void;
  onView: () => void;
}) {
  const { t } = useTranslation();
  const cancelable =
    job.state === "pending" ||
    job.state === "uploading_image" ||
    job.state === "running";
  return (
    <li className="flex items-center gap-3 px-5 py-2.5 text-sm">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Pill tone={jobStateTone(job.state)}>{t(`gen.state.${job.state}`)}</Pill>
          <span className="truncate font-medium">{job.projectName}</span>
          <span className="text-neutral-400 text-xs">
            {job.podName} · step {job.step.toLocaleString()}
          </span>
        </div>
        <div className="text-xs text-neutral-500 truncate mt-0.5">
          {job.prompt}
        </div>
        {job.error && (
          <div className="text-xs text-red-500 truncate mt-0.5">{job.error}</div>
        )}
      </div>
      {job.state === "done" && (
        <Button size="sm" variant="ghost" onClick={onView}>
          {t("gen.view")}
        </Button>
      )}
      {cancelable && (
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("gen.cancel")}
        </Button>
      )}
    </li>
  );
}

function GenerateViewerModal({
  apiKey,
  job,
  onClose,
}: {
  apiKey: string;
  job: GenerateJob;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blobRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await invoke<{ mime: string; b64: string }>(
          "read_generate_output",
          { apiKey, podId: job.podId, jobId: job.id },
        );
        if (cancelled) return;
        const bytes = Uint8Array.from(atob(r.b64), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: r.mime }));
        blobRef.current = url;
        setVideoUrl(url);
      } catch (e: any) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
      if (blobRef.current) URL.revokeObjectURL(blobRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, job.podId, job.id]);

  return (
    <Modal
      open
      onClose={onClose}
      title={job.prompt}
      width="max-w-2xl"
      footer={<Button onClick={onClose}>{t("common.cancel")}</Button>}
    >
      {error && <p className="text-xs text-red-500">{error}</p>}
      {!error && !videoUrl && (
        <div className="flex items-center justify-center py-10 text-neutral-500">
          <Spinner />
        </div>
      )}
      {videoUrl && (
        <video
          src={videoUrl}
          controls
          autoPlay
          loop
          muted
          className="w-full rounded-xl bg-black max-h-[60vh]"
        />
      )}
    </Modal>
  );
}
