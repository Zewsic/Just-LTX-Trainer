import { ReactNode, useEffect } from "react";

export default function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        className={`relative ${width} w-full mx-6 rounded-2xl border border-black/10 dark:border-white/10 bg-white/95 dark:bg-neutral-900/95 backdrop-blur-xl shadow-2xl overflow-hidden`}
      >
        {title && (
          <div className="px-5 py-3 border-b border-black/5 dark:border-white/10 text-sm font-medium">
            {title}
          </div>
        )}
        <div className="p-5 max-h-[60vh] overflow-auto">{children}</div>
        {footer && (
          <div className="px-5 py-3 border-t border-black/5 dark:border-white/10 flex justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
