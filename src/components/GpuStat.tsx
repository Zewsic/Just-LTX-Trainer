import { useTranslation } from "react-i18next";
import { Pill, Spinner } from "./ui";
import { NvidiaGpu, NvidiaInfo } from "../lib/pods";

/** Полный per-GPU блок: VRAM/Power/Util бары + температура/perf-state. */
export function GpuStat({ g }: { g: NvidiaGpu }) {
  const { t } = useTranslation();
  const memPct = g.memory_total_mb
    ? (g.memory_used_mb / g.memory_total_mb) * 100
    : 0;
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
        value={`${(g.memory_used_mb / 1024).toFixed(1)} / ${(
          g.memory_total_mb / 1024
        ).toFixed(1)} GiB`}
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

/**
 * Обёртка: список всех GPU + аккуратный плейсхолдер пока nvidia-инфа
 * подгружается. Используется в ServerDetail и в AutoCaptionBlock.
 */
export function GpuStats({
  nvidia,
  loadingLabel,
}: {
  nvidia: NvidiaInfo | null;
  loadingLabel?: string;
}) {
  if (!nvidia) {
    return (
      <p className="text-sm text-neutral-500 flex items-center gap-2">
        <Spinner /> {loadingLabel ?? "…"}
      </p>
    );
  }
  if (nvidia.gpus.length === 0) {
    return <p className="text-sm text-neutral-500">—</p>;
  }
  return (
    <div className="space-y-5">
      {nvidia.gpus.map((g) => (
        <GpuStat key={g.index} g={g} />
      ))}
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
  const colors: Record<string, string> = {
    violet: "bg-violet-500",
    amber: "bg-amber-500",
    green: "bg-green-500",
  };
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
