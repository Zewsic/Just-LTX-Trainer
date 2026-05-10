import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button, Card, Field, Pill, Select, Spinner, Textarea } from "../components/ui";
import Modal from "../components/Modal";
import {
  defaultTrainingConfig,
  loadProject,
  listProjects,
  Project,
  RANK_OPTIONS,
  saveProject,
  STEPS_MAX,
  STEPS_MIN,
  STEPS_STEP,
  TrainingConfig,
} from "../lib/projects";
import { loadManaged, ManagedPod, Pod, store } from "../lib/pods";

const NEW_SENTINEL = "__new__";

interface SshProbe {
  ok: boolean;
  host: string;
  port: number;
  user: string;
  key_used: string | null;
  error: string | null;
}

export default function Training() {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<string[] | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [managed, setManaged] = useState<ManagedPod[]>([]);
  const [livePods, setLivePods] = useState<Record<string, Pod>>({});
  const [selectedPodId, setSelectedPodId] = useState("");
  const [probe, setProbe] = useState<SshProbe | null>(null);
  const [error, setError] = useState<string | null>(null);

  const saveTimer = useRef<number | null>(null);
  const projectRef = useRef<Project | null>(null);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  // initial load
  useEffect(() => {
    (async () => {
      const k = (await store.get<string>("runpod_key")) ?? "";
      setApiKey(k || null);
      try {
        const list = await listProjects();
        setProjects(list);
        if (list.length > 0) {
          setProject(await loadProject(list[0]));
        }
      } catch (e: any) {
        setError(String(e));
      }
      const all = await loadManaged();
      setManaged(all);
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
      const preferred =
        all.find((m) => m.ltx_state !== "init")?.id ?? all[0]?.id ?? "";
      setSelectedPodId(preferred);
    })();
  }, []);

  // SSH probe
  useEffect(() => {
    if (!apiKey || !selectedPodId) {
      setProbe(null);
      return;
    }
    setProbe(null);
    invoke<SshProbe>("pod_ssh_probe", {
      apiKey,
      podId: selectedPodId,
    })
      .then(setProbe)
      .catch((e) =>
        setProbe({
          ok: false,
          host: "",
          port: 0,
          user: selectedPodId,
          key_used: null,
          error: String(e),
        }),
      );
  }, [apiKey, selectedPodId]);

  // Patch + autosave
  function patchProject(mut: (p: Project) => Project) {
    setProject((prev) => (prev ? mut(prev) : prev));
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const cur = projectRef.current;
      if (!cur) return;
      try {
        const saved = await saveProject(cur);
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
    loadProject(value).then(setProject).catch((e) => setError(String(e)));
  }

  // —————————————————— derived
  const selectedManaged = useMemo(
    () => managed.find((m) => m.id === selectedPodId) ?? null,
    [managed, selectedPodId],
  );
  const selectedLive = useMemo(
    () => livePods[selectedPodId] ?? null,
    [livePods, selectedPodId],
  );

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
                const live = livePods[m.id];
                const gpu = live?.gpu_display_name ?? "—";
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

      {/* SETTINGS */}
      {settingsAvailable && project && (
        <TrainingSettings
          project={project}
          onChange={patchProject}
          totalClips={totalClips}
          gpuName={selectedLive?.gpu_display_name ?? null}
        />
      )}
    </div>
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
  onChange,
  totalClips,
  gpuName,
}: {
  project: Project;
  onChange: (mut: (p: Project) => Project) => void;
  totalClips: number;
  gpuName: string | null;
}) {
  const { t } = useTranslation();
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
  const validationPrompts = cfg.validation_prompts ?? [];
  const validationImages = cfg.validation_images ?? [];

  const [editFor, setEditFor] = useState<number | "new" | null>(null);
  const [draft, setDraft] = useState("");

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
                          <span className="line-clamp-2">{p}</span>
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
            </div>
          </SettingRow>
        </div>
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => {}}>{t("tr.start_training")}</Button>
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

void NEW_SENTINEL; // reserved for future
