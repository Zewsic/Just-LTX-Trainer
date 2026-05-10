import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export interface XTermHandle {
  write: (data: string) => void;
  reset: () => void;
  fit: () => void;
}

const XTermPanel = forwardRef<XTermHandle>((_, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      convertEol: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 11,
      lineHeight: 1.25,
      scrollback: 5000,
      cursorBlink: false,
      cursorStyle: "underline",
      disableStdin: true,
      theme: {
        background: "#0b0c0f",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
        black: "#1e1e1e",
        red: "#f48771",
        green: "#89d185",
        yellow: "#dcdcaa",
        blue: "#569cd6",
        magenta: "#c586c0",
        cyan: "#9cdcfe",
        white: "#d4d4d4",
        brightBlack: "#5a5a5a",
        brightRed: "#f48771",
        brightGreen: "#b5cea8",
        brightYellow: "#dcdcaa",
        brightBlue: "#9cdcfe",
        brightMagenta: "#c586c0",
        brightCyan: "#9cdcfe",
        brightWhite: "#ffffff",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    try {
      fit.fit();
    } catch {
      /* container not yet measured */
    }
    termRef.current = term;
    fitRef.current = fit;

    const onResize = () => {
      try {
        fit.fit();
      } catch {
        /* noop */
      }
    };
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(containerRef.current);

    return () => {
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      write: (data: string) => termRef.current?.write(data),
      reset: () => termRef.current?.reset(),
      fit: () => {
        try {
          fitRef.current?.fit();
        } catch {
          /* noop */
        }
      },
    }),
    [],
  );

  return (
    <div
      ref={containerRef}
      className="w-full h-56 px-2 py-1.5 bg-[#0b0c0f]"
    />
  );
});

export default XTermPanel;
