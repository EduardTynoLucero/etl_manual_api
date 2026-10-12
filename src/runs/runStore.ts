// Estado de las ejecuciones EN MEMORIA (sin tablas): la que esta corriendo y la ultima de cada tipo.
// Si el servicio se reinicia, se pierde; lo que el ETL ya guardo en la BD queda guardado.
import type { DayCounters, PatientsBackfillResult } from "../etl/worksByDayEtl.js";
import type { WorkDetailsRunResult } from "../etl/maintenanceEtl.js";
import type { LogLine } from "../etl/common/logger.js";

export type RunType = "CLINICS_DOCTORS" | "WORKS_BY_DAY";
export type RunStatus = "RUNNING" | "DONE" | "ERROR";
export type DayStatus = "PENDING" | "RUNNING" | "DONE" | "ERROR" | "NOT_RUN";

export type RunDay = DayCounters & {
  day: string;
  status: DayStatus;
  updatedSince: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

// Pendientes, al terminar todos los dias: backfill de pacientes + mantenimiento (por actualizar, sin detalle)
export type RunPending = {
  status: DayStatus;
  patients: PatientsBackfillResult | null;
  stale: WorkDetailsRunResult | null;
  missing: WorkDetailsRunResult | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type RunState = {
  id: number;
  type: RunType;
  dateFrom: string | null;
  dateTo: string | null;
  status: RunStatus;
  totalDays: number;
  daysDone: number;
  currentDay: string | null;
  summary: Record<string, number> | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  requestedBy: { userId: number | null; username: string | null };
  days: RunDay[];
  pending: RunPending | null;
  // avance de 0 a 100 y lo que va haciendo (para la barra del frontend)
  progress: { percent: number; message: string } | null;
  // las mismas lineas que salen en la consola durante esta carga
  log: LogLine[];
};

let nextId = 1;
const lastByType: Record<RunType, RunState | null> = { CLINICS_DOCTORS: null, WORKS_BY_DAY: null };

const now = () => new Date().toISOString();

export function createRun(input: {
  type: RunType;
  dateFrom?: string | null;
  dateTo?: string | null;
  days?: string[];
  userId: number | null;
  username: string | null;
}): RunState {
  const days = input.days ?? [];
  const run: RunState = {
    id: nextId++,
    type: input.type,
    dateFrom: input.dateFrom ?? null,
    dateTo: input.dateTo ?? null,
    status: "RUNNING",
    totalDays: days.length,
    daysDone: 0,
    currentDay: null,
    summary: null,
    errorMessage: null,
    startedAt: now(),
    finishedAt: null,
    requestedBy: { userId: input.userId, username: input.username },
    days: days.map((day) => ({
      day,
      status: "PENDING",
      updatedSince: null,
      errorMessage: null,
      startedAt: null,
      finishedAt: null,
      pages: 0,
      orders: 0,
      detailsFetched: 0,
      detailsFailed: 0,
      worksSaved: 0,
      worksMissingClinic: 0,
      detailsSaved: 0,
      deliveryDatesUpdated: 0,
    })),
    pending:
      input.type === "WORKS_BY_DAY"
        ? { status: "PENDING", patients: null, stale: null, missing: null, errorMessage: null, startedAt: null, finishedAt: null }
        : null,
    progress: { percent: 0, message: "Iniciando…" },
    log: [],
  };
  lastByType[input.type] = run;
  return run;
}

export function getDay(run: RunState, day: string) {
  return run.days.find((d) => d.day === day)!;
}

export function finishRun(run: RunState, status: RunStatus, errorMessage: string | null, summary?: Record<string, number>) {
  run.status = status;
  run.errorMessage = errorMessage;
  run.finishedAt = now();
  run.currentDay = null;
  if (summary !== undefined) run.summary = summary;
  for (const d of run.days) if (d.status === "PENDING") d.status = "NOT_RUN";
  if (run.pending?.status === "PENDING") run.pending.status = "NOT_RUN";
}

export function lastRuns() {
  return { clinicsDoctors: lastByType.CLINICS_DOCTORS, works: lastByType.WORKS_BY_DAY };
}

export function markDayRunning(day: RunDay, updatedSince: string) {
  day.status = "RUNNING";
  day.updatedSince = updatedSince;
  day.startedAt = now();
}

export function setDayCounters(day: RunDay, counters: DayCounters, status?: DayStatus, errorMessage?: string) {
  Object.assign(day, counters);
  if (status) {
    day.status = status;
    day.finishedAt = now();
  }
  if (errorMessage) day.errorMessage = errorMessage;
}

export function markPending(pending: RunPending, status: DayStatus, errorMessage?: string) {
  pending.status = status;
  if (status === "RUNNING") pending.startedAt = now();
  else pending.finishedAt = now();
  if (errorMessage) pending.errorMessage = errorMessage;
}

const LOG_MAX = 500;

export function reportProgress(run: RunState, percent: number, message: string) {
  run.progress = { percent: Math.max(0, Math.min(100, Math.round(percent))), message };
}

export function appendLog(run: RunState, line: LogLine) {
  run.log.push(line);
  if (run.log.length > LOG_MAX) run.log.splice(0, run.log.length - LOG_MAX);
}
