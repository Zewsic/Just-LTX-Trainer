import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Button, Card, Mono, Pill, Row, Spinner } from "../components/ui";
import LtxInitProgress from "../components/LtxInitProgress";
import { useTasks } from "../lib/tasks";
import Modal from "../components/Modal";
import { Input } from "../components/ui";
import {
  loadManaged,
  ManagedPod,
  Pod,
  podPhase,
  saveManaged,
  store,
} from "../lib/pods";

const POLL_FAST = 5_000;
const POLL_SLOW = 20_000;

interface SshProbe {
  ok: boolean;
  host: string;
  port: number;
  user: string;
  key_used: string | null;
  error: string | null;
}

interface NvidiaGpu {
  index: number;
  name: string;
  driver_version: string;
  memory_used_mb: number;
  memory_total_mb: number;
  power_draw_w: number | null;
  power_limit_w: number | null;
  temperature_c: number | null;
  utilization_pct: number | null;
  perf_state: string;
}

interface NvidiaInfo {
  driver_version: string;
  cuda_version: string;
  gpus: NvidiaGpu[];
  raw: string;
}

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
  const probe = (tasks.sshProbes.get(podId) as SshProbe | undefined) ?? null;
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [hfToken, setHfToken] = useState<string>("");
  const [managed, setManaged] = useState<ManagedPod[]>([]);
  const [live, setLive] = useState<Pod | null | undefined>(undefined);
  const [nvidia, setNvidia] = useState<NvidiaInfo | null>(null);
  const [actionBusy, setActionBusy] = useState<Action | null>(null);
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [confirmInput, setConfirmInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const apiKeyRef = useRef<string | null>(null);
  const nvidiaBusy = useRef(false);
  const liveRef = useRef<Pod | null | undefined>(undefined);

  useEffect(() => {
    liveRef.current = live;
  });

  const me = useMemo(() => managed.find((m) => m.id === podId) ?? null, [managed, podId]);
  const phase = podPhase(live, me);

  // Initial
  useEffect(() => {
    (async () => {
      const k = (await store.get<string>("runpod_key")) ?? "";
      const hf = (await store.get<string>("hf_token")) ?? "";
      setApiKey(k || null);
      apiKeyRef.current = k || null;
      setHfToken(hf);
      setManaged(await loadManaged());
      if (k) await fetchLive(k);
    })();
  }, [podId]);

  async function fetchLive(key: string) {
    try {
      const list = await invoke<Pod[]>("list_pods", { apiKey: key });
      setLive(list.find((p) => p.id === podId) ?? null);
    } catch (e: any) {
      setError(String(e));
    }
  }

  async function runNvidia() {
    if (!apiKeyRef.current || nvidiaBusy.current) return;
    nvidiaBusy.current = true;
    try {
      const n = await invoke<NvidiaInfo>("pod_nvidia_smi", {
        apiKey: apiKeyRef.current,
        podId,
      });
      setNvidia(n);
    } catch {
      // soft-fail; show last known
    } finally {
      nvidiaBusy.current = false;
    }
  }

  // Live pod status — короткий polling (TasksProvider не тянет list_pods)
  useEffect(() => {
    const period =
      probe?.ok && live?.desired_status === "RUNNING" ? POLL_SLOW : POLL_FAST;
    const id = setInterval(async () => {
      if (!apiKeyRef.current) return;
      await fetchLive(apiKeyRef.current);
      if (probe?.ok) {
        await runNvidia();
      }
    }, period);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probe?.ok, live?.desired_status]);

  // First nvidia after probe goes ok
  useEffect(() => {
    if (probe?.ok && !nvidia) runNvidia();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probe?.ok]);

  async function runAction(a: Action) {
    if (!apiKeyRef.current) return;
    setActionBusy(a);
    try {
      await invoke("pod_action", {
        args: { api_key: apiKeyRef.current, pod_id: podId, action: a },
      });
      if (a === "remove") {
        const next = managed.filter((m) => m.id !== podId);
        setManaged(next);
        await saveManaged(next);
        onBack();
        return;
      }
      await fetchLive(apiKeyRef.current);
    } catch (e: any) {
      setError(String(e));
    } finally {
      setActionBusy(null);
      setConfirm(null);
      setConfirmInput("");
    }
  }

  // -- Render branches

  if (live === undefined) {
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
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← {t("detail.back")}
        </Button>
      </div>

      <Card>
        <div className="flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold tracking-tight truncate">{name}</h1>
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
            v={me?.created_at ? new Date(me.created_at).toLocaleString() : "—"}
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
            <Row k="ltx_state" v={<span className="font-mono text-xs">{me.ltx_state}</span>} />
          )}
        </div>

        {error && (
          <div className="mt-4">
            <Mono>{error}</Mono>
          </div>
        )}
      </Card>

      {/* Setup section — managed pods only */}
      {phase === "needs_setup" && me && (
        <Card title={t("detail.section_setup")}>
          <p className="text-sm text-neutral-500 mb-4">{t("detail.setup_intro")}</p>
          {!hfToken ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">{t("detail.needs_hf")}</p>
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
                const next = managed.map((m) =>
                  m.id === podId ? { ...m, ltx_state: "ready" } : m,
                );
                setManaged(next);
                await saveManaged(next);
                invoke("notify", {
                  title: t("init.notify_done_title"),
                  body: t("init.notify_done_body", { name }),
                }).catch(() => {});
              }}
            />
          )}
        </Card>
      )}

      {/* External pod hint — not managed by us */}
      {!me && live.desired_status === "RUNNING" && (
        <Card>
          <p className="text-sm text-neutral-500">{t("servers.external_hint")}</p>
        </Card>
      )}

      {/* Ready section */}
      {phase === "ready" && (
        <Card>
          <div className="flex items-center gap-3">
            <span className="w-9 h-9 rounded-full bg-green-500/15 text-green-600 dark:text-green-400 inline-flex items-center justify-center text-lg">
              ✓
            </span>
            <div>
              <div className="text-sm font-semibold">{t("detail.setup_done_title")}</div>
              <div className="text-xs text-neutral-500">{t("detail.setup_done_hint")}</div>
            </div>
          </div>
        </Card>
      )}

      {/* GPU live */}
      {probe?.ok && (
        <Card title={t("detail.section_gpu_live")}
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
          {!nvidia ? (
            <p className="text-sm text-neutral-500 flex items-center gap-2">
              <Spinner /> {t("detail.live_loading")}
            </p>
          ) : nvidia.gpus.length === 0 ? (
            <p className="text-sm text-neutral-500">—</p>
          ) : (
            <div className="space-y-5">
              {nvidia.gpus.map((g) => (
                <GpuStat key={g.index} g={g} />
              ))}
            </div>
          )}
        </Card>
      )}

      {/* SSH probe (collapsed if ok) */}
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

      {/* Confirm modal */}
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
      return { tone: "warn", label: t("servers.row_provisioning"), icon: <Spinner className="w-3 h-3" /> };
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

function GpuStat({ g }: { g: NvidiaGpu }) {
  const { t } = useTranslation();
  const memPct = g.memory_total_mb ? (g.memory_used_mb / g.memory_total_mb) * 100 : 0;
  const pwrPct =
    g.power_draw_w != null && g.power_limit_w
      ? (g.power_draw_w / g.power_limit_w) * 100
      : 0;
  const utilPct = g.utilization_pct ?? 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-green-500/15 text-green-600 dark:text-green-400 font-mono">
          GPU {g.index}
        </span>
        <span className="font-medium text-sm truncate">{g.name}</span>
        <div className="ml-auto flex gap-1.5">
          {g.perf_state && <Pill>{g.perf_state}</Pill>}
          {g.temperature_c != null && (
            <Pill>{Math.round(g.temperature_c)}°C</Pill>
          )}
        </div>
      </div>
      <Bar
        label={t("detail.vram")}
        value={`${(g.memory_used_mb / 1024).toFixed(1)} / ${(g.memory_total_mb / 1024).toFixed(1)} GiB`}
        pct={memPct}
        tone="violet"
      />
      {g.power_limit_w != null && (
        <Bar
          label={t("detail.power")}
          value={`${(g.power_draw_w ?? 0).toFixed(0)} / ${g.power_limit_w.toFixed(0)} W`}
          pct={pwrPct}
          tone="amber"
        />
      )}
      <Bar
        label={t("detail.util")}
        value={`${utilPct.toFixed(0)}%`}
        pct={utilPct}
        tone="green"
      />
    </div>
  );
}

function Bar({
  label,
  value,
  pct,
  tone,
}: {
  label: string;
  value: string;
  pct: number;
  tone: "violet" | "amber" | "green";
}) {
  const colors = { violet: "bg-violet-500", amber: "bg-amber-500", green: "bg-green-500" };
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-neutral-500">{label}</span>
        <span className="font-mono">{value}</span>
      </div>
      <div className="h-1.5 rounded-full bg-black/[0.06] dark:bg-white/[0.08] overflow-hidden">
        <div
          className={`h-full ${colors[tone]} transition-[width]`}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
