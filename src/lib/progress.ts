// Парсинг прогресса из сырого лог-буфера (включая ANSI/PTY-вывод).
// Используется и в LtxInitProgress, и в TasksProvider для отображения
// фона-заливки в списке серверов.

const ANSI_STRIP = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function stripAnsi(s: string) {
  return s.replace(ANSI_STRIP, "");
}

function toBytes(n: number, unit: string): number {
  switch (unit) {
    case "B":
      return n;
    case "KiB":
      return n * 1024;
    case "MiB":
      return n * 1024 * 1024;
    case "GiB":
      return n * 1024 ** 3;
    default:
      return n;
  }
}

function fmtMiB(n: number) {
  if (n >= 1024 * 1024 * 1024)
    return (n / (1024 * 1024 * 1024)).toFixed(2) + " GiB";
  return (n / (1024 * 1024)).toFixed(0) + " MiB";
}

function lastMatch(re: RegExp, text: string): RegExpExecArray | null {
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) last = m;
  return last;
}

export type ProgressKind =
  | "init_packages"
  | "init_env"
  | "init_model"
  | "init_encoder"
  | "init_verify"
  | "caption"
  | "test_caption"
  | "upload"
  | "build";

export interface Progress {
  pct: number;
  label: string;
}

export function parseProgress(
  kind: ProgressKind,
  rawLog: string,
): Progress | null {
  if (!rawLog) return null;
  const text = stripAnsi(rawLog);

  if (kind === "init_env") {
    // [N/M] pkgname (Installing wheels phase)
    const inst = lastMatch(/\[(\d+)\/(\d+)\]\s+\S+/g, text);
    if (inst) {
      const x = parseInt(inst[1], 10);
      const y = parseInt(inst[2], 10);
      if (y > 0) return { pct: (x / y) * 100, label: `Installing · ${x}/${y}` };
    }
    // Preparing packages... (X/Y)
    const prep = lastMatch(/Preparing packages\.\.\. \((\d+)\/(\d+)\)/g, text);
    if (prep) {
      const x = parseInt(prep[1], 10);
      const y = parseInt(prep[2], 10);
      if (y > 0)
        return { pct: (x / y) * 100, label: `Preparing · ${x}/${y}` };
    }
    // Сумма по пер-пакетным размерам
    const re =
      /([A-Za-z0-9._+-]+)\s+[─━\-]+\s+([\d.]+)\s*(B|KiB|MiB|GiB)\/([\d.]+)\s*(B|KiB|MiB|GiB)/g;
    const map = new Map<string, [number, number]>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      map.set(m[1], [
        toBytes(parseFloat(m[2]), m[3]),
        toBytes(parseFloat(m[4]), m[5]),
      ]);
    }
    if (map.size > 0) {
      let r = 0,
        tot = 0;
      for (const [a, b] of map.values()) {
        r += a;
        tot += b;
      }
      if (tot > 0)
        return {
          pct: (r / tot) * 100,
          label: `Downloading · ${fmtMiB(r)} / ${fmtMiB(tot)}`,
        };
    }
    const installed = lastMatch(/Installed (\d+) packages/g, text);
    if (installed) return { pct: 100, label: `Installed ${installed[1]} packages` };
    return null;
  }

  if (kind === "upload") {
    // runpodctl: "dataset.zip  17% |███   | (19/110 MB, 3.9 MB/s) [4s:23s]"
    const re =
      /(\d+(?:\.\d+)?)%\s*\|[^|]*\|\s*\(([\d.]+)\s*\/\s*([\d.]+)\s*(B|KB|MB|GB)(?:,\s*([\d.]+\s*[KMG]?B\/s))?(?:\)\s*\[([^\]]+)\])?/g;
    const m = lastMatch(re, text);
    if (m) {
      const pct = parseFloat(m[1]);
      const done = m[2];
      const tot = m[3];
      const unit = m[4];
      const speed = m[5] ? ` · ${m[5].replace(/\s+/g, "")}` : "";
      const eta = m[6] ? ` · ETA ${m[6].split(":").pop()}` : "";
      return { pct, label: `${done}/${tot} ${unit}${speed}${eta}` };
    }
    const p = lastMatch(/(\d+(?:\.\d+)?)%\s*\|/g, text);
    if (p) return { pct: parseFloat(p[1]), label: `${p[1]}%` };
    return null;
  }

  if (kind === "init_model" || kind === "init_encoder" || kind === "caption") {
    const fallbackLabel =
      kind === "init_model"
        ? "LTX-2.3 weights"
        : kind === "init_encoder"
        ? "Text encoder"
        : "Captioning";
    if (kind === "caption") {
      // rich progress: "Captioning ━━━━ 3/6 0:00:09 • 0:01:23"
      const rich = lastMatch(
        /(\d+)\s*\/\s*(\d+)\s+\d+:\d{2}:\d{2}\s*[•·]\s*([\d:\-]+)/g,
        text,
      );
      if (rich) {
        const x = parseInt(rich[1], 10);
        const y = parseInt(rich[2], 10);
        if (y > 0) {
          const eta = rich[3] && rich[3] !== "-:--:--" ? ` · ETA ${rich[3]}` : "";
          return { pct: (x / y) * 100, label: `${x}/${y}${eta}` };
        }
      }
      // captioning model loading
      if (/Loading captioning model/.test(text) && !/Found \d+ media/.test(text)) {
        return { pct: 0, label: "loading model…" };
      }
    }
    // tqdm: "NN%|"
    const last = lastMatch(/(\d+(?:\.\d+)?)%\|/g, text);
    if (last) {
      const pct = parseFloat(last[1]);
      return { pct, label: fallbackLabel };
    }
    return null;
  }

  return null;
}
