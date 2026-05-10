import { ReactNode } from "react";

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
      <span className="text-xs text-neutral-500 dark:text-neutral-400">{label}</span>
      {children}
      {hint && (
        <span className="text-[11px] text-neutral-500 dark:text-neutral-400">{hint}</span>
      )}
    </label>
  );
}

const inputCls =
  "w-full px-3 py-2 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] border border-transparent focus:border-blue-500/40 focus:bg-white/80 dark:focus:bg-black/30 outline-none text-sm transition";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={inputCls + " " + (props.className ?? "")} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={inputCls + " font-mono resize-y min-h-[90px] " + (props.className ?? "")}
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

import { useRef, useState } from "react";

export function Button({
  variant = "primary",
  size = "md",
  onClick,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
  size?: "sm" | "md";
}) {
  const sizeCls =
    size === "sm" ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm";
  const variantCls =
    variant === "primary"
      ? "bg-blue-500 hover:bg-blue-600 text-white shadow-sm"
      : variant === "danger"
      ? "bg-red-500 hover:bg-red-600 text-white shadow-sm"
      : "bg-black/[0.05] dark:bg-white/[0.08] hover:bg-black/10 dark:hover:bg-white/[0.14]";

  // Авто-lock: если onClick вернул Promise — блокируем повторный клик и
  // показываем «нажато» визуально, пока промис не resolved.
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
  tone?: "neutral" | "ok" | "warn" | "err" | "info";
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300",
    ok: "bg-green-500/15 text-green-600 dark:text-green-400",
    warn: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    err: "bg-red-500/15 text-red-500",
    info: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  };
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium ${tones[tone]}`}>
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
