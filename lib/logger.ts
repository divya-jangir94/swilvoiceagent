// ─── Shared client-side logger ───────────────────────────────────────────────
// Logs appear in the browser DevTools console with timestamps, colored labels,
// and structured output. Does not affect any runtime behaviour.

type Level = "info" | "ok" | "warn" | "error" | "step" | "sep";

const STYLE: Record<Level, string> = {
  info:  "color:#60a5fa;font-weight:bold",   // blue
  ok:    "color:#34d399;font-weight:bold",   // green
  warn:  "color:#fbbf24;font-weight:bold",   // amber
  error: "color:#f87171;font-weight:bold",   // red
  step:  "color:#a78bfa;font-weight:bold",   // purple
  sep:   "color:#6b7280;font-style:italic",  // grey
};

const ICON: Record<Level, string> = {
  info:  "ℹ",
  ok:    "✓",
  warn:  "⚠",
  error: "✗",
  step:  "▶",
  sep:   "─",
};

function ts(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

/** Main log function — appears in browser DevTools. */
export function vLog(level: Level, label: string, detail?: unknown): void {
  if (level === "sep") {
    console.log(`%c${"─".repeat(22)} ${label} ${"─".repeat(22)}`, STYLE.sep);
    return;
  }
  const prefix = `[${ts()}] ${ICON[level]}  ${label}`;
  if (detail !== undefined) {
    console.log(`%c${prefix}`, STYLE[level], detail);
  } else {
    console.log(`%c${prefix}`, STYLE[level]);
  }
}

/** Returns elapsed ms as a formatted string: "(312ms)" */
export function ms(startMs: number): string {
  return `(${Date.now() - startMs}ms)`;
}
