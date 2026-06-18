import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
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
} from "../components/ui";
import Modal from "../components/Modal";
import {
  aspectToWh,
  defaultTrainingConfig,
  lastUploadedPod,
  lengthToFrames,
  Project,
  RANK_OPTIONS,
  STEPS_MAX,
  STEPS_MIN,
  STEPS_STEP,
  TrainingConfig,
} from "../lib/projects";
import { ManagedPod, Pod, SshProbe, store } from "../lib/pods";
import { useSshProbe, useTasks, useTrainingState } from "../lib/tasks";
import TrainingActive from "./training/TrainingActive";
import ValidationBlock from "./training/ValidationBlock";
import type { TrainingTarget } from "../App";

const NEW_SENTINEL = "__new__";

export default function Training({
  target,
}: {
  target: TrainingTarget | null;
}) {
  const { t } = useTranslation();
  const tasks = useTasks();
  const apiKey = tasks.apiKey;
  const projects = tasks.projectList;
  const managed = tasks.managed;
  const livePods = tasks.pods;

  const [project, setProject] = useState<Project | null>(null);
  const [selectedPodId, setSelectedPodId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const saveTimer = useRef<number | null>(null);
  const projectRef = useRef<Project | null>(null);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  // initial load: target → store → первый из списка.
  useEffect(() => {
    if (project || !projects || projects.length === 0) return;
    (async () => {
      let pick: string | null = null;
      if (target?.project && projects.includes(target.project)) {
        pick = target.project;
      }
      if (!pick) {
        const last = (await store.get<string>("training_last_project")) ?? "";
        if (last && projects.includes(last)) pick = last;
      }
      if (!pick) pick = projects[0];
      const p = await tasks.loadProjectByName(pick);
      if (p) setProject(p);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, target?.nonce]);

  // Если пришёл target — подцепляем его и для пода, иначе:
  // store(`training_last_pod_<project>`) → lastUploadedPod → preferred ready.
  useEffect(() => {
    if (!project) return;
    (async () => {
      let pick: string | null = null;
      if (
        target?.pod &&
        target.project === project.name &&
        managed.some((m) => m.id === target.pod)
      ) {
        pick = target.pod;
      }
      if (!pick) {
        const k = `training_last_pod_${project.name}`;
        const last = (await store.get<string>(k)) ?? "";
        if (last && managed.some((m) => m.id === last)) pick = last;
      }
      if (!pick) {
        const lu = lastUploadedPod(project);
        if (lu && managed.some((m) => m.id === lu)) pick = lu;
      }
      if (!pick) {
        pick =
          managed.find((m) => m.ltx_state !== "init")?.id ??
          managed[0]?.id ??
          "";
      }
      if (pick && pick !== selectedPodId) setSelectedPodId(pick);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.name, managed.length, target?.nonce]);

  // Persist текущий выбор: проект и под (per-project).
  useEffect(() => {
    if (!project) return;
    store.set("training_last_project", project.name).then(() => store.save());
  }, [project?.name]);
  useEffect(() => {
    if (!project || !selectedPodId) return;
    const k = `training_last_pod_${project.name}`;
    store.set(k, selectedPodId).then(() => store.save());
  }, [project?.name, selectedPodId]);

  const probe = useSshProbe(selectedPodId);

  function patchProject(mut: (p: Project) => Project) {
    setProject((prev) => (prev ? mut(prev) : prev));
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const cur = projectRef.current;
      if (!cur) return;
      try {
        const saved = await tasks.saveProject(cur);
        setProject((prev) =>
          prev && prev.name === saved.name ? saved : prev,
        );
      } catch (e: any) {
        setError(String(e));
      }
    }, 500);
  }

  function handleSelectProject(value: string) {
    if (!value || value === project?.name) return;
    tasks
      .loadProjectByName(value)
      .then((p) => {
        if (p) setProject(p);
      })
      .catch((e) => setError(String(e)));
  }

  const selectedManaged = useMemo(
    () => managed.find((m) => m.id === selectedPodId) ?? null,
    [managed, selectedPodId],
  );
  const selectedLive = livePods.get(selectedPodId) ?? null;

  const podRunning = selectedLive?.desired_status === "RUNNING";
  const podReady = selectedManaged && selectedManaged.ltx_state !== "init";
  const sshOk = probe?.ok === true;

  const uploaded = project?.last_uploads?.[selectedPodId];
  const isUploaded =
    !!uploaded && uploaded.hash === project?.last_build_hash;

  const totalClips = useMemo(() => {
    if (!project) return 0;
    return Object.values(project.last_build_clips || {}).reduce(
      (a, b) => a + (b ?? 0),
      0,
    );
  }, [project]);

  const settingsAvailable =
    !!project &&
    !!project.last_build_hash &&
    isUploaded &&
    !!podReady &&
    sshOk;

  if (!apiKey) {
    return (
      <div className="max-w-3xl">
        <Card>
          <p className="text-sm text-neutral-500">
            {t("servers.no_key_hint")}
          </p>
        </Card>
      </div>
    );
  }

  if (projects === null) {
    return (
      <div className="max-w-3xl">
        <Card>
          <div className="py-10 flex justify-center text-neutral-500">
            <Spinner />
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-3xl">
      {/* PROJECT + SERVER */}
      <Card>
        <div className="flex items-end gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-xs text-neutral-500 mb-1.5">
              {t("tr.project")}
            </div>
            <Select
              value={project?.name ?? ""}
              onChange={(e) => handleSelectProject(e.target.value)}
            >
              {!project && <option value="">—</option>}
              {projects.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs text-neutral-500 mb-1.5">
              {t("tr.server")}
            </div>
            <Select
              value={selectedPodId}
              onChange={(e) => setSelectedPodId(e.target.value)}
            >
              {managed.length === 0 && <option value="">—</option>}
              {managed.map((m) => {
                const live = livePods.get(m.id);
                const gpu = live?.gpu_display_name ?? "—";
                const phase =
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
                    {(m.name || m.id) + " · " + gpu + " · " + phase}
                  </option>
                );
              })}
            </Select>
          </div>
        </div>

        {error && (
          <p className="mt-3 text-xs text-red-500 font-mono break-all">
            {error}
          </p>
        )}
      </Card>

      {/* CHECKS */}
      {project && (
        <Card>
          <Checks
            project={project}
            selectedManaged={selectedManaged}
            selectedLive={selectedLive}
            podRunning={podRunning}
            podReady={!!podReady}
            sshOk={sshOk}
            probe={probe}
            isUploaded={isUploaded}
          />
        </Card>
      )}

      {/* ACTIVE / SETTINGS */}
      {settingsAvailable && project && (
        <SettingsOrActive
          project={project}
          apiKey={apiKey}
          podId={selectedPodId}
          patchProject={patchProject}
          totalClips={totalClips}
          gpuName={selectedLive?.gpu_display_name ?? null}
        />
      )}
    </div>
  );
}

function SettingsOrActive({
  project,
  apiKey,
  podId,
  patchProject,
  totalClips,
  gpuName,
}: {
  project: Project;
  apiKey: string;
  podId: string;
  patchProject: (mut: (p: Project) => Project) => void;
  totalClips: number;
  gpuName: string | null;
}) {
  const tasks = useTasks();
  const trState = useTrainingState(podId, project.name);
  // Активная вьюха остаётся для running / done / failed — пользователь видит
  // итоговый интерфейс после завершения и сам возвращается в настройки
  // через кнопку «Back». Пока state не сброшен — мы тут.
  const isActive =
    !!trState &&
    (trState.state === "running" ||
      trState.state === "done" ||
      trState.state === "failed");

  if (isActive && trState) {
    return (
      <TrainingActive
        project={project}
        apiKey={apiKey}
        podId={podId}
        state={trState}
        totalClips={totalClips}
        onBack={async () => {
          await tasks.resetTraining(podId, project.name);
        }}
      />
    );
  }
  const trigger = (project.training.trigger_word ?? "")
    .trim()
    .replace(/[.\s]+$/g, "");
  return (
    <>
      <TrainingSettings
        project={project}
        apiKey={apiKey}
        podId={podId}
        onChange={patchProject}
        totalClips={totalClips}
        gpuName={gpuName}
      />
      <ValidationBlock
        apiKey={apiKey}
        podId={podId}
        projectName={project.name}
        completedSteps={[]}
        prompts={project.training.validation_prompts ?? []}
        trigger={trigger}
        mode="history"
      />
    </>
  );
}

function Checks({
  project,
  selectedManaged,
  selectedLive,
  podRunning,
  podReady,
  sshOk,
  probe,
  isUploaded,
}: {
  project: Project;
  selectedManaged: ManagedPod | null;
  selectedLive: Pod | null;
  podRunning: boolean;
  podReady: boolean;
  sshOk: boolean;
  probe: SshProbe | null;
  isUploaded: boolean;
}) {
  const { t } = useTranslation();

  if (!selectedManaged) {
    return (
      <p className="text-sm text-neutral-500">{t("tr.no_managed")}</p>
    );
  }
  if (!project.last_build_hash) {
    return <p className="text-sm text-neutral-500">{t("tr.no_built")}</p>;
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
        <Row k="GPU" v={selectedLive?.gpu_display_name ?? "—"} />
        <Row
          k="Status"
          v={(selectedLive?.desired_status ?? "—").toLowerCase()}
          mono
        />
        <Row k="ltx_state" v={selectedManaged.ltx_state} mono />
        <Row
          k="SSH"
          v={
            probe === null
              ? t("tr.checking_ssh")
              : sshOk
              ? `${probe.user}@${probe.host}:${probe.port}`
              : t("tr.needs_ssh")
          }
          mono
        />
      </div>
      <div className="flex flex-wrap gap-2 pt-1">
        {!podRunning ? (
          <Pill tone="warn">{t("tr.needs_running")}</Pill>
        ) : !podReady ? (
          <Pill tone="warn">{t("tr.needs_init")}</Pill>
        ) : probe === null ? (
          <Pill tone="neutral">
            <Spinner /> {t("tr.checking_ssh")}
          </Pill>
        ) : !sshOk ? (
          <Pill tone="err">{t("tr.needs_ssh")}</Pill>
        ) : !isUploaded ? (
          <Pill tone="warn">{t("tr.needs_upload")}</Pill>
        ) : (
          <Pill tone="ok">✓ {t("tr.status_ready")}</Pill>
        )}
      </div>
    </div>
  );
}

function TrainingSettings({
  project,
  apiKey,
  podId,
  onChange,
  totalClips,
  gpuName,
}: {
  project: Project;
  apiKey: string;
  podId: string;
  onChange: (mut: (p: Project) => Project) => void;
  totalClips: number;
  gpuName: string | null;
}) {
  const { t } = useTranslation();
  const tasks = useTasks();
  const cfg = project.training;
  const defaults = useMemo(
    () => defaultTrainingConfig({ clips: totalClips, gpu_name: gpuName }),
    [totalClips, gpuName],
  );

  const rank = cfg.rank ?? defaults.rank!;
  const mode = (cfg.mode ?? defaults.mode!) as "t2v" | "i2v" | "both";
  const steps = cfg.steps ?? defaults.steps!;
  const gradCkpt =
    cfg.enable_gradient_checkpointing ??
    defaults.enable_gradient_checkpointing!;
  const te8 =
    cfg.load_text_encoder_in_8bit ?? defaults.load_text_encoder_in_8bit!;
  const expandable =
    cfg.expandable_segments ?? defaults.expandable_segments ?? false;
  const triggerWord = (cfg.trigger_word ?? "").trim();
  const validationPrompts = cfg.validation_prompts ?? [];
  const validationImages = cfg.validation_images ?? [];

  const [editFor, setEditFor] = useState<number | "new" | null>(null);
  const [draft, setDraft] = useState("");
  const [startError, setStartError] = useState<string | null>(null);

  function patchTraining(mut: (c: TrainingConfig) => TrainingConfig) {
    onChange((p) => ({ ...p, training: mut(p.training) }));
  }

  function openEdit(i: number | "new") {
    setEditFor(i);
    setDraft(typeof i === "number" ? validationPrompts[i] ?? "" : "");
  }
  function savePrompt() {
    const v = draft.trim();
    setEditFor(null);
    setDraft("");
    if (!v) return;
    if (editFor === "new") {
      patchTraining((c) => ({
        ...c,
        validation_prompts: [...(c.validation_prompts ?? []), v],
      }));
    } else if (typeof editFor === "number") {
      patchTraining((c) => ({
        ...c,
        validation_prompts: (c.validation_prompts ?? []).map((p, i) =>
          i === editFor ? v : p,
        ),
      }));
    }
  }
  function removePrompt(i: number) {
    patchTraining((c) => ({
      ...c,
      validation_prompts: (c.validation_prompts ?? []).filter(
        (_, idx) => idx !== i,
      ),
    }));
  }
  async function pickImages() {
    const sel = await openDialog({
      multiple: true,
      directory: false,
      filters: [
        { name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] },
      ],
    });
    if (!sel) return;
    const paths = Array.isArray(sel) ? sel : [sel];
    patchTraining((c) => {
      const exist = new Set(c.validation_images ?? []);
      const next = [...(c.validation_images ?? [])];
      for (const p of paths) if (!exist.has(p)) next.push(p);
      return { ...c, validation_images: next };
    });
  }
  function removeImage(i: number) {
    patchTraining((c) => ({
      ...c,
      validation_images: (c.validation_images ?? []).filter(
        (_, idx) => idx !== i,
      ),
    }));
  }

  return (
    <>
      <Card title={t("tr.settings_title")}>
        <div className="space-y-6">
          {/* RANK */}
          <SettingRow
            label={t("tr.rank.label")}
            hint={t("tr.rank.hint")}
          >
            <div className="inline-flex rounded-lg bg-black/[0.05] dark:bg-white/[0.06] p-0.5 text-xs">
              {RANK_OPTIONS.map((r) => (
                <button
                  key={r}
                  onClick={() => patchTraining((c) => ({ ...c, rank: r }))}
                  className={
                    "px-3 py-1.5 rounded-md transition font-mono " +
                    (rank === r
                      ? "bg-white dark:bg-white/[0.12] shadow-sm font-medium"
                      : "text-neutral-500 hover:text-current")
                  }
                >
                  {r}
                </button>
              ))}
            </div>
          </SettingRow>

          {/* MODE */}
          <SettingRow label={t("tr.mode.label")} hint={t("tr.mode.hint")}>
            <div className="grid grid-cols-3 gap-2 max-w-md">
              {(["t2v", "i2v", "both"] as const).map((m) => (
                <ModeTile
                  key={m}
                  active={mode === m}
                  onClick={() => patchTraining((c) => ({ ...c, mode: m }))}
                  label={t(`tr.mode.${m}`)}
                  kind={m}
                />
              ))}
            </div>
          </SettingRow>

          {/* STEPS */}
          <SettingRow label={t("tr.steps.label")} hint={t("tr.steps.hint")}>
            <div className="space-y-2">
              <div className="flex items-baseline gap-3">
                <input
                  type="range"
                  min={STEPS_MIN}
                  max={STEPS_MAX}
                  step={STEPS_STEP}
                  value={steps}
                  onChange={(e) =>
                    patchTraining((c) => ({
                      ...c,
                      steps: parseInt(e.target.value, 10),
                    }))
                  }
                  className="flex-1 accent-blue-500"
                />
                <span className="font-mono text-sm tabular-nums w-16 text-right">
                  {steps.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between text-[10px] text-neutral-500 font-mono">
                <span>{STEPS_MIN.toLocaleString()}</span>
                <span>{STEPS_MAX.toLocaleString()}</span>
              </div>
            </div>
          </SettingRow>

          {/* TRIGGER WORD */}
          <SettingRow
            label={t("tr.trigger.label")}
            hint={t("tr.trigger.hint")}
          >
            <Input
              value={cfg.trigger_word ?? ""}
              onChange={(e) =>
                patchTraining((c) => ({
                  ...c,
                  trigger_word: e.target.value || null,
                }))
              }
              placeholder={t("tr.trigger.placeholder")}
              autoComplete="off"
              spellCheck={false}
            />
          </SettingRow>

          {/* VALIDATION */}
          <SettingRow
            label={t("tr.validation.label")}
            hint={t("tr.validation.hint")}
          >
            <div className="space-y-3">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-1.5">
                  {t("tr.validation.prompts_label")}
                </div>
                {validationPrompts.length === 0 ? (
                  <p className="text-xs text-neutral-500 mb-2">
                    {t("tr.validation.no_prompts")}
                  </p>
                ) : (
                  <ul className="space-y-1.5 mb-2">
                    {validationPrompts.map((p, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-2 px-3 py-2 rounded-lg border border-black/[0.06] dark:border-white/[0.1] bg-black/[0.02] dark:bg-white/[0.03]"
                      >
                        <span className="text-[10px] font-mono text-neutral-500 mt-0.5 w-5">
                          #{i + 1}
                        </span>
                        <button
                          className="flex-1 min-w-0 text-left text-sm hover:underline"
                          onClick={() => openEdit(i)}
                        >
                          <span className="line-clamp-2 leading-relaxed">
                            {triggerWord && (
                              <span className="px-1.5 py-0.5 mr-1 rounded-md bg-blue-500/15 text-blue-700 dark:text-blue-300 font-mono text-[12px]">
                                {triggerWord}
                              </span>
                            )}
                            {p}
                          </span>
                        </button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => removePrompt(i)}
                          className="!text-red-500"
                        >
                          ✕
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                <Button size="sm" variant="ghost" onClick={() => openEdit("new")}>
                  ＋ {t("tr.validation.add_prompt")}
                </Button>
              </div>

              <div>
                <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-1.5">
                  {t("tr.validation.images_label")}
                </div>
                {mode === "t2v" ? (
                  <p className="text-xs text-neutral-500">
                    {t("tr.validation.i2v_only")}
                  </p>
                ) : (
                  <>
                    {validationPrompts.length > 0 &&
                      (validationImages.length === 0 && mode === "i2v" ? (
                        <p className="text-xs text-red-500 mb-2">
                          {t("tr.validation.need_images", {
                            n: validationPrompts.length,
                          })}
                        </p>
                      ) : validationImages.length > 0 &&
                        validationImages.length !== validationPrompts.length ? (
                        <p className="text-xs text-red-500 mb-2">
                          {t("tr.validation.count_mismatch", {
                            imgs: validationImages.length,
                            prompts: validationPrompts.length,
                          })}
                        </p>
                      ) : null)}
                    {validationImages.length > 0 && (
                      <div className="grid grid-cols-4 gap-2 mb-2">
                        {validationImages.map((p, i) => (
                          <div
                            key={p + i}
                            className="relative aspect-square rounded-lg overflow-hidden border border-black/[0.06] dark:border-white/[0.1] bg-black/[0.04] dark:bg-white/[0.04] flex items-center justify-center group"
                          >
                            <span className="text-[10px] text-neutral-500 font-mono px-2 text-center break-all line-clamp-3">
                              {basenameOf(p)}
                            </span>
                            <button
                              onClick={() => removeImage(i)}
                              className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white text-xs opacity-0 group-hover:opacity-100 transition"
                              title={t("tr.validation.remove_image")}
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <Button size="sm" variant="ghost" onClick={pickImages}>
                      ＋ {t("tr.validation.add_images")}
                    </Button>
                  </>
                )}
              </div>
            </div>
          </SettingRow>

          {/* FLAGS */}
          <SettingRow label={t("tr.flags.label")} hint={t("tr.flags.hint")}>
            <div className="space-y-2">
              <FlagToggle
                label={t("tr.flags.grad_ckpt")}
                hint={t("tr.flags.grad_ckpt_hint")}
                value={gradCkpt}
                onChange={(v) =>
                  patchTraining((c) => ({
                    ...c,
                    enable_gradient_checkpointing: v,
                  }))
                }
              />
              <FlagToggle
                label={t("tr.flags.te_8bit")}
                hint={t("tr.flags.te_8bit_hint")}
                value={te8}
                onChange={(v) =>
                  patchTraining((c) => ({
                    ...c,
                    load_text_encoder_in_8bit: v,
                  }))
                }
              />
              <FlagToggle
                label={t("tr.flags.expandable")}
                hint={t("tr.flags.expandable_hint")}
                value={expandable}
                onChange={(v) =>
                  patchTraining((c) => ({
                    ...c,
                    expandable_segments: v,
                  }))
                }
              />
            </div>
          </SettingRow>
        </div>
      </Card>

      {cfg.raw_config_yaml && cfg.raw_config_yaml.trim() && (
        <Card>
          <div className="flex items-start gap-3">
            <span className="w-8 h-8 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 inline-flex items-center justify-center text-sm shrink-0">
              ⚡
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold">
                {t("tr.raw_banner_title")}
              </div>
              <div className="text-[11px] text-neutral-500 mt-0.5 leading-snug">
                {t("tr.raw_banner_hint")}
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                patchTraining((c) => ({ ...c, raw_config_yaml: null }))
              }
              className="!text-red-500"
            >
              {t("tr.raw_clear")}
            </Button>
          </div>
        </Card>
      )}

      <div className="flex justify-end items-center gap-3 flex-wrap">
        {startError && (
          <span className="text-xs text-red-500 max-w-md text-right">
            {startError}
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            setStartError(null);
            try {
              const buckets = computeBuckets(project);
              const clipCount = Object.values(project.last_build_clips || {})
                .reduce((a, b) => a + (b ?? 0), 0);
              const yaml = await tasks.exportTrainingConfig({
                api_key: apiKey,
                pod_id: podId,
                project_name: project.name,
                rank,
                mode,
                steps,
                trigger_word: cfg.trigger_word ?? null,
                validation_prompts: validationPrompts,
                validation_images: validationImages,
                enable_gradient_checkpointing: gradCkpt,
                load_text_encoder_in_8bit: te8,
                expandable_segments: expandable,
                audio: !!project.audio,
                clip_count: clipCount,
                buckets,
              });
              const dest = await saveDialog({
                defaultPath: `${project.name}.config.yaml`,
                filters: [
                  { name: "YAML", extensions: ["yaml", "yml"] },
                ],
              });
              if (!dest) return;
              await invoke("write_text_file", { path: dest, content: yaml });
            } catch (e: any) {
              setStartError(String(e));
            }
          }}
        >
          {t("tr.export_config")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            setStartError(null);
            try {
              const sel = await openDialog({
                multiple: false,
                directory: false,
                filters: [
                  { name: "YAML", extensions: ["yaml", "yml"] },
                ],
              });
              if (!sel || Array.isArray(sel)) return;
              const text = await invoke<string>("read_text_file", {
                path: sel,
              });
              if (!text || !text.trim()) {
                setStartError("Файл пустой");
                return;
              }
              patchTraining((c) => ({ ...c, raw_config_yaml: text }));
            } catch (e: any) {
              setStartError(String(e));
            }
          }}
        >
          {t("tr.import_raw")}
        </Button>
        <Button
          onClick={async () => {
            setStartError(null);
            const finalCfg: TrainingConfig = {
              ...cfg,
              rank,
              mode,
              steps,
              enable_gradient_checkpointing: gradCkpt,
              load_text_encoder_in_8bit: te8,
              expandable_segments: expandable,
            };
            onChange((p) => ({ ...p, training: finalCfg }));
            const buckets = computeBuckets(project);
            const clipCount = Object.values(project.last_build_clips || {})
              .reduce((a, b) => a + (b ?? 0), 0);
            const r = await tasks.startTraining({
              api_key: apiKey,
              pod_id: podId,
              project_name: project.name,
              rank,
              mode,
              steps,
              trigger_word: cfg.trigger_word ?? null,
              validation_prompts: validationPrompts,
              validation_images: validationImages,
              enable_gradient_checkpointing: gradCkpt,
              load_text_encoder_in_8bit: te8,
              expandable_segments: expandable,
              audio: !!project.audio,
              clip_count: clipCount,
              buckets,
              raw_config_yaml: cfg.raw_config_yaml ?? null,
            });
            if (!r.ok) setStartError(r.error ?? "start failed");
          }}
        >
          {t("tr.start_training")}
        </Button>
      </div>

      {/* prompt edit modal */}
      <Modal
        open={editFor !== null}
        onClose={() => {
          setEditFor(null);
          setDraft("");
        }}
        title={
          editFor === "new"
            ? t("tr.validation.add_prompt")
            : t("tr.validation.prompts_label")
        }
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setEditFor(null);
                setDraft("");
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={savePrompt}>{t("ds.prompts.save")}</Button>
          </>
        }
      >
        <Field label={t("tr.validation.prompts_label")}>
          <Textarea
            autoFocus
            rows={5}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("tr.validation.prompt_placeholder")}
          />
        </Field>
      </Modal>
    </>
  );
}

function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-12 gap-4">
      <div className="col-span-4">
        <div className="text-sm font-medium">{label}</div>
        {hint && (
          <div className="text-[11px] text-neutral-500 mt-0.5 leading-snug">
            {hint}
          </div>
        )}
      </div>
      <div className="col-span-8">{children}</div>
    </div>
  );
}

function ModeTile({
  active,
  onClick,
  label,
  kind,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  kind: "t2v" | "i2v" | "both";
}) {
  return (
    <button
      onClick={onClick}
      className={
        "rounded-xl border p-3 transition flex flex-col items-start gap-1 " +
        (active
          ? "border-blue-500 bg-blue-500/10 text-blue-600 dark:text-blue-400"
          : "border-black/[0.08] dark:border-white/[0.1] hover:bg-black/[0.04] dark:hover:bg-white/[0.05]")
      }
    >
      <ModeIcon kind={kind} />
      <span className="text-xs font-medium">{label}</span>
    </button>
  );
}

function ModeIcon({ kind }: { kind: "t2v" | "i2v" | "both" }) {
  if (kind === "t2v") {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 6h10" />
        <path d="M4 10h6" />
        <rect x="14" y="6" width="7" height="6" rx="1" />
        <path d="m17 18-2-2 2-2" />
        <path d="M19 14v4" />
      </svg>
    );
  }
  if (kind === "i2v") {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="8" height="8" rx="1" />
        <circle cx="6" cy="7" r="0.8" fill="currentColor" />
        <path d="m4 12 3-3 4 3" />
        <rect x="14" y="6" width="7" height="6" rx="1" />
      </svg>
    );
  }
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="6" height="6" rx="1" />
      <path d="M4 14h6" />
      <rect x="14" y="6" width="7" height="6" rx="1" />
    </svg>
  );
}

function FlagToggle({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer select-none px-3 py-2 rounded-lg border border-black/[0.06] dark:border-white/[0.1] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 accent-blue-500"
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm">{label}</div>
        {hint && (
          <div className="text-[11px] text-neutral-500 mt-0.5">{hint}</div>
        )}
      </div>
    </label>
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

function basenameOf(p: string) {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Бакеты для process_dataset: из last_build_buckets если есть, иначе один
 *  бакет из aspect+length (старая логика fixed-режима). */
function computeBuckets(project: Project): Array<[number, number, number]> {
  const built = project.last_build_buckets;
  if (built && built.length > 0) return built;
  const [w, h] = aspectToWh(project.aspect_ratio);
  const f = lengthToFrames(project.length_seconds);
  return [[w, h, f]];
}

void NEW_SENTINEL; // reserved for future
