// Ejecuta los ETLs que pide el frontend, de a UNA ejecucion a la vez (las dos usan la misma API externa y las
// mismas tablas STG).
// - En este proceso: variable `active`.
// - Entre procesos (p. ej. pm2 con 2 instancias): candado de MySQL GET_LOCK(LOCK_NAME), tomado en una conexion
//   propia mientras dura la ejecucion (no crea tablas).
import { DateTime } from "luxon";
import { pool } from "../db.js";
import { config } from "../config.js";
import { logger, setLogSink } from "../etl/common/logger.js";
import { runClinicsDoctorsEtl } from "../etl/clinicsDoctorsEtl.js";
import {
  addDayCounters,
  backfillMissingPatientsFromDetails,
  newDayCounters,
  runWorksDay,
  updatedSinceForDay,
} from "../etl/worksByDayEtl.js";
import { runPendingMaintenance } from "../etl/maintenanceEtl.js";
import { ensureWorkDependenciesReady } from "../etl/worksDependencies.js";
import type { RunContext } from "./context.js";
import * as store from "./runStore.js";

const LOCK_NAME = "etl_manual_api_run";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let active: store.RunState | null = null;
let starting = false;

export function activeRun() {
  return active;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/* =====================================================================
 * Validacion del rango de fechas
 * ===================================================================== */

/** Dias del rango, del primero al ultimo ("YYYY-MM-DD"). Lanza HttpError 400 si el rango no es valido. */
export function daysOfRange(dateFrom: unknown, dateTo: unknown): string[] {
  const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (!isDate(dateFrom) || !isDate(dateTo)) {
    throw new HttpError(400, "dateFrom y dateTo son obligatorios, con formato YYYY-MM-DD.");
  }

  const from = DateTime.fromISO(dateFrom as string, { zone: config.tz });
  const to = DateTime.fromISO(dateTo as string, { zone: config.tz });
  if (!from.isValid || !to.isValid) throw new HttpError(400, "dateFrom o dateTo no es una fecha valida.");
  if (to < from) throw new HttpError(400, "La fecha fin no puede ser menor que la fecha de inicio.");

  const today = DateTime.now().setZone(config.tz).startOf("day");
  if (to.startOf("day") > today) throw new HttpError(400, "La fecha fin no puede ser mayor que hoy.");

  const total = Math.round(to.diff(from, "days").days) + 1;
  if (total > config.works.maxDays) {
    throw new HttpError(400, `El rango no puede ser mayor a ${config.works.maxDays} dias (pediste ${total}).`);
  }

  const days: string[] = [];
  for (let d = from; d <= to; d = d.plus({ days: 1 })) days.push(d.toISODate()!);
  return days;
}

/* =====================================================================
 * Inicio
 * ===================================================================== */

async function acquireLock() {
  const conn = await pool.getConnection();
  try {
    const [rows]: any = await conn.query("SELECT GET_LOCK(?, 0) AS ok", [LOCK_NAME]);
    if (Number(rows?.[0]?.ok) !== 1) {
      conn.release();
      return null;
    }
  } catch (err) {
    conn.release();
    throw err;
  }

  // MySQL cierra las conexiones inactivas (wait_timeout) y con ellas el candado: un SELECT 1 cada 5 min lo evita
  const keepAlive = setInterval(() => {
    conn.query("SELECT 1").catch((err: any) => logger.warn(`Candado ETL manual: ping fallo ${err?.message ?? err}`));
  }, 5 * 60_000);

  return async () => {
    clearInterval(keepAlive);
    try {
      await conn.query("SELECT RELEASE_LOCK(?)", [LOCK_NAME]);
    } catch {
      // si la conexion ya se cayo, MySQL ya libero el candado
    }
    conn.release();
  };
}

/** Arranca una ejecucion en segundo plano y la devuelve. 409 si ya hay una corriendo. */
export async function startRun(input: {
  type: store.RunType;
  dateFrom?: string;
  dateTo?: string;
  userId: number | null;
  username: string | null;
}): Promise<store.RunState> {
  const days = input.type === "WORKS_BY_DAY" ? daysOfRange(input.dateFrom, input.dateTo) : [];

  if (active || starting) {
    throw new HttpError(409, `Ya hay una ejecucion en curso${active ? ` (#${active.id})` : ""}. Espera a que termine.`);
  }
  starting = true; // reservado desde ya, para que dos clics seguidos no arranquen dos ejecuciones

  let releaseLock: (() => Promise<void>) | null = null;
  try {
    releaseLock = await acquireLock();
    if (!releaseLock) throw new HttpError(409, "Ya hay una ejecucion en curso en otra instancia del servicio.");

    if (input.type === "WORKS_BY_DAY" && !(await ensureWorkDependenciesReady())) {
      throw new HttpError(409, "Las tablas de clinicas o doctores estan vacias: primero ejecuta la carga de doctores.");
    }
  } catch (err) {
    if (releaseLock) await releaseLock();
    starting = false;
    throw err;
  }

  const run = store.createRun({
    type: input.type,
    dateFrom: input.dateFrom ?? null,
    dateTo: input.dateTo ?? null,
    days,
    userId: input.userId,
    username: input.username,
  });
  active = run;
  starting = false;
  // desde aqui, lo que sale en la consola tambien queda en run.log (GET /status) para el modal
  setLogSink((line) => store.appendLog(run, line));

  const release = releaseLock;
  logger.info(
    `[run ${run.id}] inicio type=${input.type}` +
      (days.length ? ` dias=${days[0]}..${days[days.length - 1]} (${days.length})` : "") +
      ` user=${input.username ?? input.userId ?? "-"}`
  );

  void execute(run)
    .catch((err) => logger.error(`[run ${run.id}] error inesperado`, err?.stack ?? err))
    .finally(async () => {
      await release();
      if (active === run) active = null;
      logger.info(`[run ${run.id}] fin status=${run.status}`);
      setLogSink(null);
    });

  return run;
}

/* =====================================================================
 * Ejecucion
 * ===================================================================== */

function errorText(err: any) {
  const status = err?.response?.status;
  const url = err?.config?.url;
  if (status) return `La API respondio ${status}${url ? ` en ${url}` : ""}: ${err?.message ?? ""}`.trim();
  return String(err?.message ?? err);
}

async function execute(run: store.RunState) {
  const ctx: RunContext = { runId: run.id };

  if (run.type === "CLINICS_DOCTORS") {
    const report = (percent: number, message: string) => store.reportProgress(run, percent, message);
    try {
      const summary = await runClinicsDoctorsEtl(ctx, report);
      report(100, "Sincronización terminada");
      store.finishRun(run, "DONE", null, summary);
    } catch (err: any) {
      logger.error(`[run ${run.id}] ERROR`, err?.stack ?? err);
      const message = errorText(err);
      report(run.progress?.percent ?? 0, `Error: ${message}`);
      store.finishRun(run, "ERROR", message);
    }
    return;
  }

  // WORKS_BY_DAY: un dia completo (listado + mantenimiento) y despues el siguiente
  let total = newDayCounters();

  // Avance para la barra del frontend: los dias son el 0..90% (partes iguales) y los pendientes el 90..99%.
  // La API no dice cuantas paginas tiene un dia (solo has_more): dentro del dia se estima con las paginas del
  // dia anterior (con updated_since cada dia trae lo mismo o menos que el anterior).
  const report = (percent: number, message: string) => store.reportProgress(run, percent, message);
  const dayShare = 90 / Math.max(1, run.days.length);
  let prevDayPages = 0;

  for (const [index, dayState] of run.days.entries()) {
    const day = dayState.day;
    const dayLabel = `Día ${index + 1} de ${run.days.length} (${day})`;
    let dayCounters = newDayCounters();
    try {
      store.markDayRunning(dayState, updatedSinceForDay(day));
      run.currentDay = day;
      report(index * dayShare, `${dayLabel}: leyendo órdenes…`);

      dayCounters = await runWorksDay(ctx, day, (partial) => {
        dayCounters = partial;
        store.setDayCounters(dayState, partial);
        run.summary = addDayCounters(total, partial);
        const fraction = prevDayPages
          ? Math.min(0.95, partial.pages / prevDayPages)
          : Math.min(0.95, partial.pages / (partial.pages + 3));
        report(
          (index + fraction) * dayShare,
          `${dayLabel}: página ${partial.pages}, ${partial.orders} órdenes, ${partial.detailsFetched} detalles`
        );
      });
      prevDayPages = dayCounters.pages;

      store.setDayCounters(dayState, dayCounters, "DONE");
      total = addDayCounters(total, dayCounters);
      run.daysDone += 1;
      run.summary = total;
    } catch (err: any) {
      logger.error(`[run ${run.id}] Works ${day}: ERROR`, err?.stack ?? err);
      const message = errorText(err);
      // lo que alcanzo a guardar ese dia queda guardado (cada pagina se guarda completa)
      store.setDayCounters(dayState, dayCounters, "ERROR", message);
      store.finishRun(run, "ERROR", `Dia ${day}: ${message}`, addDayCounters(total, dayCounters));
      return;
    }

    if (index < run.days.length - 1 && config.works.dayPauseMs) await sleep(config.works.dayPauseMs);
  }

  // Pendientes, como lo hacian los ETLs (sin el barrido completo): backfill de pacientes del listado y
  // mantenimiento de ordenes de works con status cambiado o sin detalle.
  const pending = run.pending!;
  run.currentDay = null;
  try {
    if (config.works.dayPauseMs) await sleep(config.works.dayPauseMs);
    store.markPending(pending, "RUNNING");
    report(90, "Pendientes: pacientes faltantes…");
    pending.patients = await backfillMissingPatientsFromDetails(ctx);
    report(93, "Pendientes: órdenes con status cambiado…");
    await runPendingMaintenance((pass, result) => {
      pending[pass] = result;
      if (pass === "stale") report(96, "Pendientes: órdenes sin detalle…");
    });
    store.markPending(pending, "DONE");
  } catch (err: any) {
    logger.error(`[run ${run.id}] Pendientes: ERROR`, err?.stack ?? err);
    const message = errorText(err);
    store.markPending(pending, "ERROR", message);
    store.finishRun(run, "ERROR", `Pendientes: ${message}`, total);
    return;
  }

  report(100, "Carga terminada");
  store.finishRun(run, "DONE", null, total);
}
