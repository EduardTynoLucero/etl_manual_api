export type LogLevel = "INFO" | "WARN" | "ERROR";
export type LogLine = { at: string; level: LogLevel; message: string };

// Ademas de la consola, mientras corre una carga las mismas lineas se guardan en esa carga
// (GET /status -> log) para mostrarlas en el modal del frontend.
let sink: ((line: LogLine) => void) | null = null;

export function setLogSink(fn: ((line: LogLine) => void) | null) {
  sink = fn;
}

function extraText(extra: any) {
  if (extra === undefined || extra === null || extra === "") return "";
  const text = typeof extra === "string" ? extra : extra?.message ?? JSON.stringify(extra);
  return ` ${String(text).split("\n")[0].slice(0, 500)}`;
}

function toSink(level: LogLevel, at: string, msg: string, extra?: any) {
  if (!sink) return;
  try {
    sink({ at, level, message: `${msg}${extraText(extra)}` });
  } catch {
    // el log del modal nunca debe tumbar la carga
  }
}

export const logger = {
  info: (msg: string, extra?: any) => {
    const at = new Date().toISOString();
    console.log(`[INFO] ${at} ${msg}`, extra ?? "");
    toSink("INFO", at, msg, extra);
  },
  warn: (msg: string, extra?: any) => {
    const at = new Date().toISOString();
    console.warn(`[WARN] ${at} ${msg}`, extra ?? "");
    toSink("WARN", at, msg, extra);
  },
  error: (msg: string, extra?: any) => {
    const at = new Date().toISOString();
    console.error(`[ERR ] ${at} ${msg}`, extra ?? "");
    toSink("ERROR", at, msg, extra);
  },
};
