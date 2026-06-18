import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Button, Card, Mono, Pill, Row, Spinner } from "../components/ui";
import LtxInitProgress from "../components/LtxInitProgress";
import { GpuStats } from "../components/GpuStat";
import {
  useManagedPod,
  useNvidia,
  usePod,
  useSshProbe,
  useTasks,
} from "../lib/tasks";
import Modal from "../components/Modal";
import { Input } from "../components/ui";
import { podPhase } from "../lib/pods";

type Action = "start" | "stop" | "restart" | "remove";

export default function ServerDetail({
  podId,
  onBack,
}: {
  podId: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const tasks = useTasks();
  const live = usePod(podId);
  const me = useManagedPod(podId);
  const probe = useSshProbe(podId);
  const nvidia = useNvidia(podId);

  const [actionBusy, setActionBusy] = useState<Action | null>(null);
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [confirmInput, setConfirmInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const apiKey = tasks.apiKey;
  const hfToken = tasks.hfToken;
  const phase = podPhase(live, me);

  async function runAction(a: Action) {
    if (!apiKey) return;
    setActionBusy(a);
    try {
      await invoke("pod_action", {
        args: { api_key: apiKey, pod_id: podId, action: a },
      });
      if (a === "remove") {
        await tasks.setManaged(tasks.managed.filter((m) => m.id !== podId));
        onBack();
        return;
      }
      await tasks.reloadPods();
    } catch (e: any) {
      setError(String(e));
    } finally {
      setActionBusy(null);
      setConfirm(null);
      setConfirmInput("");
    }
  }

  if (live === null && tasks.pods.size === 0) {
    return (
      <Card>
        <div className="py-10 flex justify-center text-neutral-500">
          <Spinner />
        </div>
      </Card>
    );
  }

  if (!live) {
    return (
      <Card>
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← {t("detail.back")}
        </Button>
        <p className="mt-4 text-sm text-neutral-500">Pod not found</p>
      </Card>
    );
  }

  const name = me?.name || live.name || live.id;
  const phaseUI = phaseLabel(phase, t);

  const actions: { id: Action; label: string; variant?: "danger" | "ghost" }[] = [
    live.desired_status === "RUNNING"
      ? { id: "stop", label: t("detail.actions_stop") }
      : { id: "start", label: t("detail.actions_start") },
    { id: "restart", label: t("detail.actions_restart") },
    { id: "remove", label: t("detail.actions_delete"), variant: "danger" },
  ];

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← {t("detail.back")}
        </Button>
      </div>

      <Card>
        <div className="flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold tracking-tight truncate">
              {name}
            </h1>
            <div className="flex items-center gap-2 mt-1.5">
              <Pill tone={phaseUI.tone}>
                {phaseUI.icon}
                {phaseUI.label}
              </Pill>
              {live.gpu_display_name && (
                <span className="text-xs text-neutral-500">
                  {live.gpu_display_name}
                  {live.gpu_count ? ` × ${live.gpu_count}` : ""}
                </span>
              )}
            </div>
          </div>
          <div className="flex gap-1.5 shrink-0">
            {actions.map((a) => (
              <Button
                key={a.id}
                variant={a.variant ?? "ghost"}
                size="sm"
                disabled={actionBusy === a.id}
                onClick={() => {
                  if (a.id === "start") return runAction("start");
                  setConfirm(a.id);
                }}
              >
                {a.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-x-6">
          <Row
            k={t("detail.cost")}
            v={live.cost_per_hr != null ? `$${live.cost_per_hr.toFixed(3)}` : "—"}
          />
          <Row
            k={t("detail.created")}
            v={
              me?.created_at
                ? new Date(me.created_at).toLocaleString()
                : "—"
            }
          />
          {probe?.ok && (
            <Row
              k={t("detail.address")}
              v={
                <span className="font-mono text-xs">
                  {probe.user}@{probe.host}:{probe.port}
                </span>
              }
            />
          )}
          {me && (
            <Row
              k="ltx_state"
              v={<span className="font-mono text-xs">{me.ltx_state}</span>}
            />
          )}
        </div>

        {error && (
          <div className="mt-4">
            <Mono>{error}</Mono>
          </div>
        )}
      </Card>

      {phase === "needs_setup" && me && (
        <Card title={t("detail.section_setup")}>
          <p className="text-sm text-neutral-500 mb-4">
            {t("detail.setup_intro")}
          </p>
          {!hfToken ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t("detail.needs_hf")}
            </p>
          ) : !probe?.ok ? (
            <p className="text-xs text-neutral-500 flex items-center gap-2">
              <Spinner /> {t("detail.needs_ssh")}
            </p>
          ) : (
            <LtxInitProgress
              apiKey={apiKey!}
              podId={podId}
              hfToken={hfToken}
              onComplete={async () => {
                await tasks.setManaged(
                  tasks.managed.map((m) =>
                    m.id === podId ? { ...m, ltx_state: "ready" } : m,
                  ),
                );
                invoke("notify", {
                  title: t("init.notify_done_title"),
                  body: t("init.notify_done_body", { name }),
                }).catch(() => {});
              }}
            />
          )}
        </Card>
      )}

      {!me && live.desired_status === "RUNNING" && (
        <Card>
          <p className="text-sm text-neutral-500">
            {t("servers.external_hint")}
          </p>
        </Card>
      )}

      {phase === "ready" && (
        <Card>
          <div className="flex items-center gap-3">
            <span className="w-9 h-9 rounded-full bg-green-500/15 text-green-600 dark:text-green-400 inline-flex items-center justify-center text-lg">
              ✓
            </span>
            <div>
              <div className="text-sm font-semibold">
                {t("detail.setup_done_title")}
              </div>
              <div className="text-xs text-neutral-500">
                {t("detail.setup_done_hint")}
              </div>
            </div>
          </div>
        </Card>
      )}

      {probe?.ok && (
        <Card
          title={t("detail.section_gpu_live")}
          action={
            nvidia && (
              <div className="flex gap-2">
                {nvidia.driver_version && (
                  <Pill>Driver {nvidia.driver_version}</Pill>
                )}
                {nvidia.cuda_version && <Pill>CUDA {nvidia.cuda_version}</Pill>}
              </div>
            )
          }
        >
          <GpuStats nvidia={nvidia} loadingLabel={t("detail.live_loading")} />
        </Card>
      )}

      {!probe?.ok && live.desired_status === "RUNNING" && (
        <Card title={t("detail.section_ssh")}>
          {probe === null ? (
            <p className="text-sm text-neutral-500 flex items-center gap-2">
              <Spinner /> {t("detail.ssh_waiting")}
            </p>
          ) : (
            <>
              <Pill tone="err">✕ {t("detail.ssh_failed")}</Pill>
              <div className="mt-3">
                <Mono>{probe.error ?? "?"}</Mono>
              </div>
            </>
          )}
        </Card>
      )}

      <Modal
        open={!!confirm}
        onClose={() => {
          if (!actionBusy) {
            setConfirm(null);
            setConfirmInput("");
          }
        }}
        title={
          confirm === "remove"
            ? t("detail.delete_title")
            : confirm === "stop"
            ? t("detail.stop_title")
            : t("detail.restart_title")
        }
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirm(null);
                setConfirmInput("");
              }}
              disabled={!!actionBusy}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant={confirm === "remove" ? "danger" : "primary"}
              disabled={
                !!actionBusy ||
                (confirm === "remove" && confirmInput !== name)
              }
              onClick={() => confirm && runAction(confirm)}
            >
              {confirm === "remove"
                ? t("common.delete")
                : confirm === "stop"
                ? t("detail.actions_stop")
                : t("detail.actions_restart")}
            </Button>
          </>
        }
      >
        <p className="text-sm">
          {confirm === "remove"
            ? t("detail.delete_body", { name })
            : confirm === "stop"
            ? t("detail.stop_body", { name })
            : t("detail.restart_body", { name })}
        </p>
        {confirm === "remove" && (
          <div className="mt-4">
            <Input
              autoFocus
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              placeholder={name}
            />
          </div>
        )}
      </Modal>
    </div>
  );
}

function phaseLabel(
  phase: ReturnType<typeof podPhase>,
  t: (k: string) => string,
): { tone: any; label: string; icon?: React.ReactNode } {
  switch (phase) {
    case "provisioning":
      return {
        tone: "warn",
        label: t("servers.row_provisioning"),
        icon: <Spinner className="w-3 h-3" />,
      };
    case "needs_setup":
      return { tone: "info", label: t("servers.row_setting_up") };
    case "ready":
      return { tone: "ok", label: t("servers.row_ready") };
    case "running":
      return { tone: "ok", label: t("servers.row_running") };
    case "stopped":
      return { tone: "neutral", label: t("servers.row_stopped") };
    default:
      return { tone: "neutral", label: t("servers.row_unknown") };
  }
}

