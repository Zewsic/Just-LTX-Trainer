import { useTranslation } from "react-i18next";
import { open as openShell } from "@tauri-apps/plugin-shell";

export type Section = "servers" | "datasets" | "training" | "settings";

const top: Section[] = ["servers", "datasets", "training"];
const bottom: Section[] = ["settings"];

const icons: Record<Section, React.ReactNode> = {
  servers: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="6" rx="2" />
      <rect x="3" y="14" width="18" height="6" rx="2" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
      <line x1="7" y1="17" x2="7.01" y2="17" />
    </svg>
  ),
  datasets: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m22 8-6 4 6 4V8Z" />
      <rect x="2" y="6" width="14" height="12" rx="2" />
    </svg>
  ),
  training: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L4 6v6c0 5 3.5 9 8 10 4.5-1 8-5 8-10V6l-8-4z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
  settings: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
};

export default function Sidebar({
  current,
  onChange,
}: {
  current: Section;
  onChange: (s: Section) => void;
}) {
  const { t } = useTranslation();
  const renderBtn = (s: Section) => (
    <button
      key={s}
      onClick={() => onChange(s)}
      className={
        "flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition w-full " +
        (current === s
          ? "bg-black/[0.08] dark:bg-white/[0.1] font-medium"
          : "text-neutral-600 dark:text-neutral-400 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]")
      }
    >
      <span className="opacity-80">{icons[s]}</span>
      <span>{t(`nav.${s}`)}</span>
    </button>
  );

  return (
    <aside
      data-tauri-drag-region
      className="w-56 shrink-0 border-r border-black/[0.06] dark:border-white/10 p-3 select-none flex flex-col"
    >
      <div className="px-3 pt-7 pb-5">
        <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">LTX</div>
        <div className="text-sm font-semibold tracking-tight">Just LTX Trainer</div>
      </div>
      <nav className="flex flex-col gap-0.5">{top.map(renderBtn)}</nav>
      <div className="flex-1" />
      <nav className="flex flex-col gap-0.5">
        <button
          onClick={() => openShell("https://t.me/ZewBlog").catch(() => {})}
          className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition w-full text-neutral-600 dark:text-neutral-400 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
        >
          <span className="opacity-80">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M21.94 4.45a1.5 1.5 0 0 0-1.6-.21L3.4 11.17a1.2 1.2 0 0 0 .07 2.22l4.06 1.45 1.6 5.04a1 1 0 0 0 1.66.4l2.34-2.18 4.18 3.04a1.2 1.2 0 0 0 1.88-.71l3.27-14.36a1.5 1.5 0 0 0-.52-1.62Zm-3.6 3.41-7.85 7a.5.5 0 0 0-.16.26l-.85 3.13-1.05-3.3 9.6-7.36a.18.18 0 0 1 .31.22Z" />
            </svg>
          </span>
          <span>Telegram</span>
          <span className="ml-auto text-neutral-400 text-xs">↗</span>
        </button>
        {bottom.map(renderBtn)}
      </nav>
    </aside>
  );
}
