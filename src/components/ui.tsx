import { ReactNode, useRef, useState } from "react";

// ──────────────────────────────────────────────────────────────────────────
// Tone palette — единый источник цвета для Pill, StatusIcon, ProgressBar,
// Banner. Меняется в одном месте.
// ──────────────────────────────────────────────────────────────────────────

export type Tone = "neutral" | "ok" | "warn" | "err" | "info";
export type Status = "pending" | "running" | "done" | "failed";

export const TONE_BG: Record<Tone, string> = {
  neutral: "bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300",
  ok: "bg-green-500/15 text-green-600 dark:text-green-400",
  warn: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  err: "bg-red-500/15 text-red-500",
  info: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
};

const TONE_FILL: Record<Tone, string> = {
  neutral: "bg-neutral-400",
  ok: "bg-green-500",
  warn: "bg-amber-500",
  err: "bg-red-500",
  info: "bg-blue-500",
};

const TONE_BORDER: Record<Tone, string> = {
  neutral: "border-black/[0.08] dark:border-white/[0.1]",
  ok: "border-green-500/30",
  warn: "border-amber-500/30",
  err: "border-red-500/30",
  info: "border-blue-500/30",
};

export function statusToTone(s: Status): Tone {
  switch (s) {
    case "running":
      return "info";
    case "done":
      return "ok";
    case "failed":
      return "err";
    default:
      return "neutral";
  }
}

// ──────────────────────────────────────────────────────────────────────────

export function Card({
  title,
  action,
  children,
  className = "",
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={
        "rounded-2xl border border-black/[0.06] dark:border-white/10 bg-white/70 dark:bg-white/[0.04] backdrop-blur-xl shadow-sm " +
        className
      }
    >
      {title && (
        <div className="px-5 pt-4 pb-3 flex items-center gap-3">
          <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
          {action && <div className="ml-auto">{action}</div>}
        </div>
      )}
      <div className={title ? "px-5 pb-5" : "p-5"}>{children}</div>
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="text-xs text-neutral-500 dark:text-neutral-400">
        {label}
      </span>
      {children}
      {hint && (
        <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
          {hint}
        </span>
      )}
    </label>
  );
}

const inputCls =
  "w-full px-3 py-2 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] border border-transparent focus:border-blue-500/40 focus:bg-white/80 dark:focus:bg-black/30 outline-none text-sm transition";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input {...props} className={inputCls + " " + (props.className ?? "")} />
  );
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={
        inputCls +
        " font-mono resize-y min-h-[90px] " +
        (props.className ?? "")
      }
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={"select-styled " + inputCls + " pr-9 " + (props.className ?? "")}
    />
  );
}

export function Button({
  variant = "primary",
  size = "md",
  onClick,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
  size?: "sm" | "md";
}) {
  const sizeCls = size === "sm" ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm";
  const variantCls =
    variant === "primary"
      ? "bg-blue-500 hover:bg-blue-600 text-white shadow-sm"
      : variant === "danger"
      ? "bg-red-500 hover:bg-red-600 text-white shadow-sm"
      : "bg-black/[0.05] dark:bg-white/[0.08] hover:bg-black/10 dark:hover:bg-white/[0.14]";

  const [pending, setPending] = useState(false);
  const lockRef = useRef(false);
  const handleClick: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    if (lockRef.current) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!onClick) return;
    const r = onClick(e) as unknown;
    if (r && typeof (r as any).then === "function") {
      lockRef.current = true;
      setPending(true);
      (r as Promise<unknown>).finally(() => {
        lockRef.current = false;
        setPending(false);
      });
    }
  };

  return (
    <button
      {...props}
      onClick={handleClick}
      disabled={props.disabled || pending}
      className={
        `${sizeCls} ${variantCls} rounded-lg font-medium transition disabled:opacity-50 disabled:cursor-not-allowed ` +
        (props.className ?? "")
      }
    />
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return (
    <pre className="font-mono text-[11px] leading-snug whitespace-pre-wrap break-all bg-black/5 dark:bg-black/30 rounded-lg p-3 max-h-[280px] overflow-auto">
      {children}
    </pre>
  );
}

export function Pill({
  tone = "neutral",
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium ${TONE_BG[tone]}`}
    >
      {children}
    </span>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg
      className={"animate-spin " + className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
    >
      <path d="M21 12a9 9 0 1 1-6.2-8.55" />
    </svg>
  );
}

export function Row({
  k,
  v,
  mono,
}: {
  k: ReactNode;
  v: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-sm">
      <span className="text-neutral-500 dark:text-neutral-400 text-xs">{k}</span>
      <span className={"truncate " + (mono ? "font-mono text-xs" : "")}>{v}</span>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// StatusIcon — единый источник иконок состояния
// ──────────────────────────────────────────────────────────────────────────

export function StatusIcon({
  status,
  size = "md",
}: {
  status: Status;
  size?: "sm" | "md";
}) {
  const dim = size === "sm" ? "w-5 h-5" : "w-6 h-6";
  const text = size === "sm" ? "text-[10px]" : "text-xs";
  const dot = size === "sm" ? "w-1.5 h-1.5" : "w-2 h-2";

  const base = `${dim} ${text} inline-flex items-center justify-center rounded-full shrink-0`;

  if (status === "done")
    return <span className={`${base} bg-green-500/20 text-green-600 dark:text-green-400`}>✓</span>;
  if (status === "failed")
    return <span className={`${base} bg-red-500/20 text-red-500`}>✕</span>;
  if (status === "running")
    return (
      <span className={`${base} bg-blue-500/20`}>
        <span className={`block ${dot} rounded-full bg-blue-500 animate-pulse`} />
      </span>
    );
  return (
    <span className={`${base} bg-black/5 dark:bg-white/10 text-neutral-500`}>
      ○
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// ProgressBar — все варианты прогресса в одном компоненте
//
// variant="bar"     — отдельный thin bar (h-2) с лейблом сверху
// variant="fill"    — заливка фона у строки/контейнера (для списков)
// variant="button"  — синяя плашка-кнопка с заливкой по %
// ──────────────────────────────────────────────────────────────────────────

export interface ProgressBarProps {
  /** 0–100 */
  pct?: number | null;
  variant?: "bar" | "fill" | "button";
  tone?: Tone;
  /** Слева сверху (variant=bar) или внутри плашки (variant=button) */
  label?: ReactNode;
  /** Справа сверху (variant=bar). Часто значение/ETA. */
  value?: ReactNode;
  className?: string;
  /** Для variant="fill" — высота элемента сверху не задаётся, эффект чисто фоновый */
  children?: ReactNode;
}

export function ProgressBar({
  pct,
  variant = "bar",
  tone = "info",
  label,
  value,
  className = "",
  children,
}: ProgressBarProps) {
  const clamped =
    typeof pct === "number" ? Math.max(0, Math.min(100, pct)) : 0;
  const indeterminate = pct == null;

  if (variant === "fill") {
    return (
      <div className={`relative overflow-hidden ${className}`}>
        {clamped > 0 && (
          <div
            className={`absolute inset-y-0 left-0 ${TONE_FILL[tone]} opacity-15 transition-[width] pointer-events-none`}
            style={{ width: `${clamped}%` }}
          />
        )}
        <div className="relative">{children}</div>
      </div>
    );
  }

  if (variant === "button") {
    return (
      <div
        className={`relative overflow-hidden rounded-lg ${TONE_BG[tone]} px-4 py-2 text-sm font-medium min-w-[180px] ${className}`}
      >
        <div
          className={`absolute inset-y-0 left-0 ${TONE_FILL[tone]} opacity-30 transition-[width]`}
          style={{ width: `${clamped}%` }}
        />
        <span className="relative inline-flex items-center gap-2 whitespace-nowrap">
          <Spinner /> {label}
        </span>
      </div>
    );
  }

  // bar
  return (
    <div className={className}>
      {(label || value) && (
        <div className="flex items-baseline justify-between text-xs mb-1.5 gap-3">
          <span className="text-neutral-500 truncate">{label}</span>
          {value && (
            <span className="font-mono tabular-nums text-neutral-500 shrink-0">
              {value}
            </span>
          )}
        </div>
      )}
      <div className="h-2 rounded-full bg-black/[0.06] dark:bg-white/[0.08] overflow-hidden">
        <div
          className={`h-full ${TONE_FILL[tone]} transition-[width] ${
            indeterminate ? "w-1/4 animate-pulse" : ""
          }`}
          style={indeterminate ? undefined : { width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Banner — карточка-плашка для активных операций (build/upload/...).
// Используется на экране Servers как «диспетчерская сводка».
// ──────────────────────────────────────────────────────────────────────────

export function Banner({
  tone = "info",
  pct,
  title,
  subtitle,
  action,
}: {
  tone?: Tone;
  pct?: number | null;
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  const clamped =
    typeof pct === "number" ? Math.max(0, Math.min(100, pct)) : null;
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border ${TONE_BORDER[tone]} ${TONE_BG[tone]} px-5 py-3.5`}
    >
      {clamped != null && clamped > 0 && (
        <div
          className={`absolute inset-y-0 left-0 ${TONE_FILL[tone]} opacity-10 transition-[width] pointer-events-none`}
          style={{ width: `${clamped}%` }}
        />
      )}
      <div className="relative flex items-center gap-3">
        <Spinner />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate text-current">{title}</div>
          {subtitle && (
            <div className="text-xs text-neutral-500 truncate">{subtitle}</div>
          )}
        </div>
        {clamped != null && (
          <span className="font-mono text-sm tabular-nums shrink-0">
            {clamped.toFixed(0)}%
          </span>
        )}
        {action}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Toggle — сегментный переключатель (servers filter, dataset tabs, и т.п.)
// ──────────────────────────────────────────────────────────────────────────

export function Toggle<T extends string>({
  items,
  value,
  onChange,
  size = "md",
  className = "",
}: {
  items: ReadonlyArray<{ id: T; label: ReactNode; disabled?: boolean }>;
  value: T;
  onChange: (id: T) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  const padCls = size === "sm" ? "px-3 py-1.5 text-xs" : "px-4 py-1.5 text-sm";
  return (
    <div
      className={`inline-flex rounded-lg bg-black/[0.05] dark:bg-white/[0.06] p-0.5 ${className}`}
    >
      {items.map((it) => {
        const active = it.id === value;
        return (
          <button
            key={it.id}
            disabled={it.disabled}
            onClick={() => !it.disabled && onChange(it.id)}
            className={
              `${padCls} rounded-md transition whitespace-nowrap ` +
              (active
                ? "bg-white dark:bg-white/[0.12] shadow-sm font-medium"
                : "text-neutral-500 hover:text-current") +
              (it.disabled ? " opacity-50 cursor-not-allowed" : "")
            }
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
