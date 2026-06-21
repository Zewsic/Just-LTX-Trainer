import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import Modal from "./Modal";
import { Button, Field, Input, Pill, Mono, Toggle } from "./ui";

export type CloudType = "SECURE" | "COMMUNITY";

export interface GpuType {
  id: string;
  display_name: string;
  memory_in_gb: number | null;
  price_per_hr: number | null;
  community_price_per_hr: number | null;
  stock_status: string | null;
  community_stock_status: string | null;
  available: boolean;
  community_available: boolean;
  secure_cloud: boolean;
  community_cloud: boolean;
  tag: "recommended" | "not_recommended" | null;
}

function gpuPrice(g: GpuType, cloud: CloudType): number | null {
  return cloud === "SECURE" ? g.price_per_hr : g.community_price_per_hr;
}

function gpuAvailable(g: GpuType, cloud: CloudType): boolean {
  return cloud === "SECURE" ? g.available : g.community_available;
}

interface DeployResult {
  id: string;
  name: string;
  desired_status: string;
  image_name: string | null;
}

function genName() {
  const b = new Uint8Array(3);
  crypto.getRandomValues(b);
  return "ltx-" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export default function CreateServer({
  open,
  apiKey,
  onClose,
  onCreated,
}: {
  open: boolean;
  apiKey: string;
  onClose: () => void;
  onCreated: (created: DeployResult, gpu: GpuType) => void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<"gpu" | "confirm">("gpu");
  const [gpus, setGpus] = useState<GpuType[] | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [cloud, setCloud] = useState<CloudType>("SECURE");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep("gpu");
    setGpus(null);
    setPickedId(null);
    setCloud("SECURE");
    setName(genName());
    setError(null);
    invoke<GpuType[]>("list_gpu_types", { apiKey })
      .then((list) => {
        setGpus(list);
        const rec = list.find((g) => g.available && g.tag === "recommended");
        if (rec) setPickedId(rec.id);
      })
      .catch((e) => setError(String(e)));
  }, [open, apiKey]);

  const picked = useMemo(
    () => (gpus && pickedId ? gpus.find((g) => g.id === pickedId) ?? null : null),
    [gpus, pickedId],
  );
  // Если выбранный GPU не доступен в текущем облаке — снимаем выбор,
  // чтобы пользователь не уехал на "Next" с недоступной картой.
  const pickedAvailable = picked ? gpuAvailable(picked, cloud) : false;
  const validName = /^[a-zA-Z0-9_\- ]{1,64}$/.test(name.trim());

  async function deploy() {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const res = await invoke<DeployResult>("deploy_pod", {
        args: {
          api_key: apiKey,
          gpu_type_id: picked.id,
          name: name.trim(),
          cloud_type: cloud,
        },
      });
      onCreated(res, picked);
    } catch (e: any) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={t("create.title")}
      width="max-w-2xl"
      footer={
        step === "gpu" ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!picked || !pickedAvailable}
              onClick={() => setStep("confirm")}
            >
              {t("create.next")}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setStep("gpu")} disabled={busy}>
              ← {t("common.back")}
            </Button>
            <Button onClick={deploy} disabled={!validName || busy}>
              {busy ? t("create.deploying") : t("create.deploy")}
            </Button>
          </>
        )
      }
    >
      {step === "gpu" ? (
        <GpuPicker
          gpus={gpus}
          pickedId={pickedId}
          onPick={setPickedId}
          cloud={cloud}
          onCloudChange={setCloud}
          error={error}
        />
      ) : (
        <ConfirmStep
          name={name}
          setName={setName}
          gpu={picked}
          cloud={cloud}
          validName={validName}
          error={error}
        />
      )}
    </Modal>
  );
}

function GpuPicker({
  gpus,
  pickedId,
  onPick,
  cloud,
  onCloudChange,
  error,
}: {
  gpus: GpuType[] | null;
  pickedId: string | null;
  onPick: (id: string) => void;
  cloud: CloudType;
  onCloudChange: (c: CloudType) => void;
  error: string | null;
}) {
  const { t } = useTranslation();
  if (error) return <Mono>{error}</Mono>;
  if (!gpus) return <p className="text-sm text-neutral-500">{t("create.loading_gpus")}</p>;
  if (gpus.length === 0)
    return <p className="text-sm text-neutral-500">{t("create.no_gpus")}</p>;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Toggle<CloudType>
          size="sm"
          value={cloud}
          onChange={onCloudChange}
          items={[
            { id: "SECURE", label: t("create.cloud_secure") },
            { id: "COMMUNITY", label: t("create.cloud_community") },
          ]}
        />
        <span className="text-[11px] text-neutral-500 leading-snug">
          {cloud === "SECURE"
            ? t("create.cloud_secure_hint")
            : t("create.cloud_community_hint")}
        </span>
      </div>
      <ul className="space-y-1.5">
        {gpus.map((g) => {
          const selected = pickedId === g.id;
          const price = gpuPrice(g, cloud);
          const available = gpuAvailable(g, cloud);
          return (
            <li key={g.id}>
              <button
                disabled={!available}
                onClick={() => onPick(g.id)}
                className={
                  "w-full text-left px-4 py-3 rounded-xl border transition flex items-center gap-3 " +
                  (selected
                    ? "border-blue-500 bg-blue-500/10"
                    : "border-black/[0.06] dark:border-white/10 hover:bg-black/[0.04] dark:hover:bg-white/[0.05]") +
                  (!available ? " opacity-50 cursor-not-allowed" : "")
                }
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium truncate">{g.display_name}</span>
                    {g.tag === "recommended" && available && (
                      <Pill tone="info">{t("create.tag_recommended")}</Pill>
                    )}
                    {g.tag === "not_recommended" && available && (
                      <Pill tone="warn">{t("create.tag_for_tests")}</Pill>
                    )}
                    {!available && <Pill>{t("create.tag_unavailable")}</Pill>}
                  </div>
                  <div className="text-xs text-neutral-500 mt-0.5">
                    {g.memory_in_gb != null
                      ? `${t("create.vram")} ${g.memory_in_gb} GB`
                      : "—"}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-mono text-sm">
                    {price != null ? `$${price.toFixed(3)}` : "—"}
                  </div>
                  <div className="text-[10px] text-neutral-500">{t("create.hourly")}</div>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ConfirmStep({
  name,
  setName,
  gpu,
  cloud,
  validName,
  error,
}: {
  name: string;
  setName: (v: string) => void;
  gpu: GpuType | null;
  cloud: CloudType;
  validName: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  if (!gpu) return null;
  const price = gpuPrice(gpu, cloud);
  return (
    <div className="space-y-5">
      <Field label={t("create.name")}>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          spellCheck={false}
          className={!validName ? "!border-red-500/40" : ""}
        />
      </Field>

      <div className="rounded-xl border border-black/[0.06] dark:border-white/10 p-4 space-y-2">
        <div className="text-xs text-neutral-500">{t("create.summary")}</div>
        <SummaryLine label={t("detail.gpu")} value={`${gpu.display_name} × 1`} />
        <SummaryLine
          label={t("create.cloud_type")}
          value={
            cloud === "SECURE"
              ? t("create.cloud_secure")
              : t("create.cloud_community")
          }
        />
        <SummaryLine
          label={t("detail.cost")}
          value={price != null ? `$${price.toFixed(3)}` : "—"}
        />
        <SummaryLine
          label="Image"
          value={t("create.summary_template")}
          mono
        />
        <SummaryLine label="Disks" value={t("create.summary_disks")} />
        <SummaryLine label="Setup" value={t("create.summary_ssh")} />
        <SummaryLine label="Billing" value={t("create.summary_billing")} />
      </div>

      {error && <Mono>{error}</Mono>}
    </div>
  );
}

function SummaryLine({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-neutral-500 text-xs">{label}</span>
      <span className={mono ? "font-mono text-xs truncate" : "truncate"}>{value}</span>
    </div>
  );
}
