// Ordenes de trabajo de UN dia: listado + mantenimiento (detalle), con las mismas tablas y SQL de los ETLs.
//
// 1. Listado (schedule_works_order_list_etl, modo UPDATED_SINCE): /works?updated_since=<D 00:00>&page=0,1,2...
//    hasta que la API ya no devuelve datos.
// 2. Por cada pagina, por cada orden: /works/{id} (WORKS_RANGE_DETAIL_CONCURRENCY a la vez). Con ese detalle:
//    - works / patients (stg_works, stg_patients): igual que el listado (status, status_name y fecha de envio
//      salen del detalle).
//    - external_work_details + tareas, productos, tags, lotes y catalogos: igual que el mantenimiento
//      (schedule_works_order_details_etl), y despues copia la fecha de envio a works.estimated_delivery.
// 3. Al terminar el dia: re-vincula doctor_id / clinic_id de las ordenes que llegaron antes que su doctor/clinica.
//
// Igual que el listado en modo UPDATED_SINCE, no hace soft delete de ordenes.
import { DateTime } from "luxon";
import { createHash } from "node:crypto";
import { logger } from "./common/logger.js";
import { paginate } from "./common/pagination.js";
import { bulkInsert } from "./common/bulkInsert.js";
import { withTx } from "./common/tx.js";
import { exec, execQuery } from "../db.js";
import { config } from "../config.js";
import { SQL } from "./sql.js";
import { cleanText, persistDetails, syncWorksEstimatedDelivery, toMysqlDate, uniqueNumbers, type DetailResult } from "./detailStore.js";
import { logMissingWorkDependencies, relinkWorkReferences } from "./worksDependencies.js";
import { fetchWorkDetail, fetchWorksPageWithMeta } from "./api/worksApiClient.js";
import type { RunContext } from "../runs/context.js";
import type { WorkItem } from "../types/worksApi.js";

export type DayCounters = {
  pages: number; // paginas del listado con datos
  orders: number; // ordenes que devolvio el listado
  detailsFetched: number; // /works/{id} consultados
  detailsFailed: number; // /works/{id} que fallaron (la orden conserva lo que ya tenia)
  worksSaved: number; // ordenes guardadas en works
  worksMissingClinic: number; // ordenes NO guardadas porque su clinica aun no existe en clients
  detailsSaved: number; // detalles guardados en external_work_details
  deliveryDatesUpdated: number; // works.estimated_delivery actualizadas con la fecha de envio
};

export function newDayCounters(): DayCounters {
  return {
    pages: 0,
    orders: 0,
    detailsFetched: 0,
    detailsFailed: 0,
    worksSaved: 0,
    worksMissingClinic: 0,
    detailsSaved: 0,
    deliveryDatesUpdated: 0,
  };
}

export function addDayCounters(total: DayCounters, day: DayCounters): DayCounters {
  const out = { ...total };
  for (const key of Object.keys(out) as Array<keyof DayCounters>) out[key] += day[key];
  return out;
}

/** "2026-10-01" -> "2026-10-01T00:00:00-06:00" (inicio del dia en hora de Guatemala, como el ETL del listado). */
export function updatedSinceForDay(day: string): string {
  return DateTime.fromISO(day, { zone: config.tz }).startOf("day").toISO({ suppressMilliseconds: true })!;
}

/* =====================================================================
 * Copiado de schedule_works_order_list_etl/src/etl/worksEtl.ts (paciente, firma del listado, valores del detalle)
 * ===================================================================== */

function normalizePatientKeyPart(value?: string | number | null) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function patientName(w: WorkItem) {
  return w.patient?.name ?? w.patient_name ?? null;
}

function clinicExternalId(w: WorkItem) {
  return w.clinic_id ?? w.clinic?.id ?? null;
}

function doctorExternalId(w: WorkItem) {
  return w.doctor_id ?? w.doctor?.id ?? null;
}

function patientAge(w: WorkItem) {
  const rawAge = w.patient?.age?.trim();
  if (!rawAge) return null;

  const match = rawAge.match(/\d+/);
  return match ? Number(match[0]) : null;
}

function buildPatientKey(w: WorkItem) {
  const name = normalizePatientKeyPart(patientName(w));
  if (!name) return null;

  const rawKey = [
    normalizePatientKeyPart(clinicExternalId(w)),
    name,
    normalizePatientKeyPart(w.patient?.sex),
    normalizePatientKeyPart(patientAge(w)),
  ].join("|");

  return createHash("sha256").update(rawKey).digest("hex");
}

type WorkState = {
  workId: number;
  status: string | null;
  statusName: string | null;
  estimatedDelivery: string | null;
};

type DetailValues = {
  status: string | null;
  statusName: string | null;
  deliveryNoteDate: string | null; // YYYY-MM-DD
};

/** Lo que ya hay en works para estas ordenes. */
async function loadWorksState(ids: number[]) {
  const state = new Map<number, WorkState>();
  if (!ids.length) return state;

  const rows = await execQuery<
    Array<{
      work_id: number;
      external_id: number;
      status: string | null;
      status_name: string | null;
      estimated_delivery: string | null;
    }>
  >(
    `
      SELECT w.work_id, w.external_id, w.status, w.status_name,
             DATE_FORMAT(w.estimated_delivery, '%Y-%m-%d %H:%i:%s') AS estimated_delivery
      FROM works w
      WHERE w.external_id IN (?)
    `,
    [ids]
  );

  for (const row of rows) {
    state.set(Number(row.external_id), {
      workId: Number(row.work_id),
      status: cleanText(row.status),
      statusName: cleanText(row.status_name),
      estimatedDelivery: cleanText(row.estimated_delivery),
    });
  }
  return state;
}

function detailValuesOf(detail: WorkItem): DetailValues {
  return {
    status: cleanText(detail.status),
    statusName: cleanText(detail.status_name),
    deliveryNoteDate: toMysqlDate(detail.delivery_note_date),
  };
}

/** Orden del listado con status, status_name y fecha de envio del detalle. */
function withDetailValues(w: WorkItem, values: DetailValues, detail?: WorkItem | null): WorkItem {
  const merged: WorkItem = {
    ...w,
    status: values.status ?? w.status,
    status_name: values.statusName ?? w.status_name,
    estimated_delivery: values.deliveryNoteDate,
    delivery_note_date: values.deliveryNoteDate,
  };

  if (detail) {
    if (!patientName(w)?.trim()) {
      merged.patient = detail.patient ?? w.patient;
      merged.patient_name = detail.patient_name ?? w.patient_name;
    }
    if (clinicExternalId(w) === null) {
      merged.clinic_id = detail.clinic_id ?? w.clinic_id;
      merged.clinic = detail.clinic ?? w.clinic;
    }
    if (doctorExternalId(w) === null) {
      merged.doctor_id = detail.doctor_id ?? w.doctor_id;
      merged.doctor = detail.doctor ?? w.doctor;
    }
  }

  return merged;
}

/** Sin detalle nuevo: conservar lo que ya hay en works (el status y la fecha del listado no sirven). */
function withCurrentValues(w: WorkItem, current?: WorkState): WorkItem {
  if (!current) return { ...w, estimated_delivery: null };
  return {
    ...w,
    status: current.status ?? w.status,
    status_name: current.statusName ?? w.status_name,
    estimated_delivery: current.estimatedDelivery,
  };
}

async function stageWorks(works: WorkItem[]) {
  if (!works.length) return;

  const rows = works.map((w) => ([
    w.id ?? null,
    w.code ?? null,
    w.box ?? null,
    w.created_at ?? null,
    w.accept_date ?? null,
    w.estimated_delivery ?? null,
    w.finish_date ?? null,
    w.status ?? null,
    w.status_name ?? null,

    // clinic
    clinicExternalId(w),
    clinicExternalId(w),

    // doctor
    null, // doctor_id local (lo resuelve el upsert con JOIN)
    doctorExternalId(w),

    // patient
    null
  ]));

  await bulkInsert(
    "stg_works",
    [
      "external_id","code","box","created_at_api","accepted_date","estimated_delivery","finish_date",
      "status","status_name",
      "clinic_id","clinic_external_id",
      "doctor_id","doctor_external_id",
      "patient_id"
    ],
    rows,
    1000
  );

  const patientRows = works
    .map((w) => {
      const patientKey = buildPatientKey(w);
      const name = patientName(w);
      if (!patientKey || !name?.trim()) return null;

      return [
        patientKey,
        w.id ?? null,
        clinicExternalId(w),
        name,
        patientAge(w),
        w.patient?.sex ?? null,
        w.patient?.sex_name ?? null,
      ];
    })
    .filter((row): row is any[] => row !== null);

  if (patientRows.length) {
    await bulkInsert(
      "stg_patients",
      ["patient_key", "work_external_id", "clinic_external_id", "name", "age", "sex", "sex_name"],
      patientRows,
      1000
    );
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  });

  await Promise.all(workers);
  return results;
}

/* =====================================================================
 * Una pagina del listado: detalle -> works/patients -> external_work_details
 * ===================================================================== */

async function processPage(
  ctx: RunContext,
  day: string,
  page: number,
  items: WorkItem[],
  counters: DayCounters
) {
  const ids = uniqueNumbers(items.map((w) => (Number.isFinite(Number(w.id)) && Number(w.id) > 0 ? Number(w.id) : null)));
  const state = await loadWorksState(ids);
  const details = new Map<number, WorkItem>();

  const enriched = await mapWithConcurrency(items, config.works.detailConcurrency, async (w) => {
    const id = Number(w.id);
    if (!Number.isFinite(id) || id <= 0) return withCurrentValues(w, undefined);

    try {
      const detail = await fetchWorkDetail(id);
      if (!detail?.id) throw new Error("detalle vacio");
      counters.detailsFetched += 1;
      details.set(id, detail);
      return withDetailValues(w, detailValuesOf(detail), detail);
    } catch (err: any) {
      counters.detailsFailed += 1;
      logger.warn(
        `[run ${ctx.runId}] Works ${day}: no pude cargar detalle work_id=${id} ` +
          `status=${err?.response?.status ?? err?.code ?? err?.message ?? "unknown"}`
      );
      return withCurrentValues(w, state.get(id));
    }
  });

  // listado: works + patients (stg_works / stg_patients, una pagina a la vez)
  await exec(SQL.truncateStgWorks);
  await exec(SQL.truncateStgPatients);
  await stageWorks(enriched);
  const { worksMissingClinic } = await logMissingWorkDependencies(`dia ${day} page=${page}`);
  await withTx(async (conn) => {
    await conn.execute(SQL.upsertPatientsFromStg);
    await conn.execute(SQL.upsertWorksFromStg);
  });
  counters.worksSaved += Math.max(0, ids.length - worksMissingClinic);
  counters.worksMissingClinic += worksMissingClinic;

  // mantenimiento: detalle completo de las ordenes que ya quedaron en works (las nuevas ya tienen work_id)
  if (details.size) {
    const refs = await loadWorksState([...details.keys()]);
    const toSave: DetailResult[] = [];
    for (const [id, detail] of details) {
      const current = refs.get(id);
      if (current) toSave.push({ ref: { work_id: current.workId, external_id: id }, detail });
    }
    if (toSave.length) {
      await persistDetails(toSave);
      counters.detailsSaved += toSave.length;
      counters.deliveryDatesUpdated += await syncWorksEstimatedDelivery(toSave.map((r) => r.ref.external_id));
    }
  }
}

/**
 * Corre listado + mantenimiento del dia `day` (YYYY-MM-DD).
 * onProgress: se llama despues de cada pagina (avance para GET /status).
 */
export async function runWorksDay(
  ctx: RunContext,
  day: string,
  onProgress: (counters: DayCounters) => void
): Promise<DayCounters> {
  const updatedSince = updatedSinceForDay(day);
  const counters = newDayCounters();
  const startedAt = Date.now();

  logger.info(
    `[run ${ctx.runId}] Works ${day}: start updated_since=${updatedSince} ` +
      `detailConcurrency=${config.works.detailConcurrency}`
  );

  await paginate<WorkItem>(
    async (page) => fetchWorksPageWithMeta(page, updatedSince),
    async (items, page) => {
      if (!items.length) return;
      await processPage(ctx, day, page, items, counters);
      counters.pages += 1;
      counters.orders += items.length;
      logger.info(
        `[run ${ctx.runId}] Works ${day}: page=${page} ordenes=${items.length} ` +
          `detalles consultados=${counters.detailsFetched} fallidos=${counters.detailsFailed}`
      );
      onProgress({ ...counters });
    },
    { pageStart: 0, label: `Works ${day}`, delayMs: config.works.pageDelayMs }
  );

  await relinkWorkReferences();

  logger.info(
    `[run ${ctx.runId}] Works ${day}: done paginas=${counters.pages} ordenes=${counters.orders} ` +
      `detalles=${counters.detailsFetched} fallidos=${counters.detailsFailed} ` +
      `works=${counters.worksSaved} sin_clinica=${counters.worksMissingClinic} detalles_guardados=${counters.detailsSaved} ` +
      `(${Math.round((Date.now() - startedAt) / 1000)}s)`
  );
  return counters;
}

/* =====================================================================
 * Backfill de pacientes: COPIA de backfillMissingPatientsFromDetails (schedule_works_order_list_etl/worksEtl.ts)
 * Ordenes de works sin paciente -> /works/{id} -> works/patients + external_work_details.
 * ===================================================================== */

export type PatientsBackfillResult = { consulted: number; fetched: number; failed: number; applied: number };

// ordenes ya intentadas por el backfill de pacientes -> cuando (en memoria)
const backfillTried = new Map<number, number>();

export async function backfillMissingPatientsFromDetails(ctx: RunContext): Promise<PatientsBackfillResult> {
  const result: PatientsBackfillResult = { consulted: 0, fetched: 0, failed: 0, applied: 0 };
  if (!config.pending.backfillMissingPatients) return result;

  const limit = Math.max(0, config.pending.backfillMissingPatientsLimit);
  if (!limit) return result;
  const limitSql = Math.trunc(limit);

  const missingWorksAll = await exec<Array<{ external_id: number }>>(
    `
      SELECT external_id
      FROM works
      WHERE external_id IS NOT NULL
        AND patient_id IS NULL
        AND is_deleted = 0
      ORDER BY created_at_api DESC, work_id DESC
      LIMIT ${limitSql}
    `
  );

  // [VELOCIDAD] no volver a intentar en cada vuelta las mismas ordenes (p. ej. las que dan 404)
  const retryMs = Math.max(0, config.pending.backfillRetryHours) * 3_600_000;
  const nowMs = Date.now();
  const missingWorks = missingWorksAll.filter(({ external_id }) => {
    const last = backfillTried.get(Number(external_id));
    return !last || nowMs - last >= retryMs;
  });
  for (const { external_id } of missingWorks) backfillTried.set(Number(external_id), nowMs);
  if (!missingWorks.length) return result;
  result.consulted = missingWorks.length;

  logger.info(
    `[run ${ctx.runId}] Works: backfill pacientes faltantes start total=${missingWorks.length} ` +
      `concurrency=${Math.max(1, config.works.detailConcurrency)}`
  );

  let processed = 0;
  const works = await mapWithConcurrency(
    missingWorks,
    Math.max(1, config.works.detailConcurrency),
    async ({ external_id }) => {
      try {
        const detail = await fetchWorkDetail(external_id);
        if (detail && patientName(detail)?.trim()) result.fetched += 1;
        return detail;
      } catch (err: any) {
        result.failed += 1;
        logger.warn(
          `[run ${ctx.runId}] Works: no pude cargar detalle faltante work_id=${external_id} ` +
            `status=${err?.response?.status ?? err?.code ?? err?.message ?? "unknown"}`
        );
        return null;
      } finally {
        processed += 1;
        if (processed % 50 === 0 || processed === missingWorks.length) {
          logger.info(
            `[run ${ctx.runId}] Works: backfill pacientes faltantes progreso=${processed}/${missingWorks.length} ` +
              `fetched=${result.fetched} failed=${result.failed}`
          );
        }
      }
    }
  );

  const worksWithPatient = works.filter((w): w is WorkItem => Boolean(w && patientName(w)?.trim()));
  if (!worksWithPatient.length) {
    logger.info(
      `[run ${ctx.runId}] Works: backfill pacientes faltantes sin registros aplicables ` +
        `consultados=${missingWorks.length} failed=${result.failed}`
    );
    return result;
  }

  // [ENVIO] en el backfill los registros son detalles: se guarda el detalle completo (hijo) y en works
  // estimated_delivery = delivery_note_date
  const backfillState = await loadWorksState(uniqueNumbers(worksWithPatient.map((w) => Number(w.id))));
  const backfillSave: DetailResult[] = [];
  for (const w of worksWithPatient) {
    const current = backfillState.get(Number(w.id));
    if (current) backfillSave.push({ ref: { work_id: current.workId, external_id: Number(w.id) }, detail: w });
  }
  if (backfillSave.length) await persistDetails(backfillSave);
  await exec(SQL.truncateStgWorks);
  await exec(SQL.truncateStgPatients);
  await stageWorks(
    worksWithPatient.map((w) => ({ ...w, estimated_delivery: toMysqlDate(w.delivery_note_date) }))
  );
  await withTx(async (conn) => {
    await conn.execute(SQL.upsertPatientsFromStg);
    await conn.execute(SQL.upsertWorksFromStg);
  });
  result.applied = worksWithPatient.length;

  logger.info(
    `[run ${ctx.runId}] Works: backfill pacientes faltantes aplicados=${worksWithPatient.length} ` +
      `consultados=${missingWorks.length} fetched=${result.fetched} failed=${result.failed}`
  );
  return result;
}
