// Mantenimiento de ordenes sobre la tabla works: COPIA de schedule_works_order_details_etl/src/etl/workDetailsEtl.ts
// (con WORK_DETAILS_ONLY_MISSING=1): primero "por actualizar" (status / finish_date cambiaron o les falta fecha) y
// despues "sin detalle" (ordenes de works sin fila en external_work_details). NO incluye el barrido completo diario.
// Lo corre POST /works al terminar los dias del rango.
import { config } from "../config.js";
import { exec } from "../db.js";
import { fetchWorkDetail } from "./api/worksApiClient.js";
import { logger } from "./common/logger.js";
import { getWorkExternalId, persistDetails, syncWorksEstimatedDelivery, uniqueNumbers, type DetailResult, type WorkRef } from "./detailStore.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
) {
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

// Ordenes con detalle ya guardado que conviene volver a pedir:
// - el ETL del listado cambio status o finish_date en works (el detalle quedo viejo)
// - terminadas en los ultimos N dias y el detalle todavia no trae delivery_note_date (fecha de envio)
// - creadas en los ultimos N dias sin ninguna fecha estimada (ni en works ni en el detalle)
// Solo si el detalle se guardo hace mas de WORK_DETAILS_REFRESH_MIN_AGE_MINUTES, para no pedir la misma
// orden en cada vuelta si la API tarda en reflejar el cambio.
function refreshMinAge() {
  return Math.max(0, Math.trunc(config.pending.refreshMinAgeMinutes));
}

function refreshMissingDatesDays() {
  return Math.max(0, Math.trunc(config.pending.refreshMissingDatesDays));
}

function needsRefreshSql(): { sql: string; params: number[] } {
  const days = refreshMissingDatesDays();
  // COLLATE: en la BD works.status es utf8mb4_0900_ai_ci y external_work_details.status utf8mb4_unicode_ci;
  // sin esto MySQL da "Illegal mix of collations" (el ETL de detalle original falla en esta consulta).
  const reasons = [
    "NOT (w.status COLLATE utf8mb4_unicode_ci <=> ewd.status)",
    "NOT (w.finish_date <=> ewd.finish_date)",
  ];
  const params: number[] = [];

  if (days > 0) {
    reasons.push("(ewd.delivery_note_date IS NULL AND w.finish_date >= CURDATE() - INTERVAL ? DAY)");
    params.push(days);
    reasons.push(
      "(w.estimated_delivery IS NULL AND ewd.estimated_delivery IS NULL AND w.created_at_api >= NOW() - INTERVAL ? DAY)"
    );
    params.push(days);
  }

  params.push(refreshMinAge());
  return {
    sql:
      `(${reasons.join(" OR ")}) ` +
      "AND (ewd.updated_at IS NULL OR ewd.updated_at < NOW() - INTERVAL ? MINUTE)",
    params,
  };
}

/**
 * Que ordenes toma cada pasada:
 * - all: todas (aqui no se usa: el barrido completo no va en este proyecto)
 * - missing: sin fila en external_work_details (ordenes nuevas)
 * - stale: con detalle, pero hay que volver a pedirlo (ver needsRefreshSql)
 */
export type RefsFilter = "all" | "missing" | "stale";

export async function logPendingRefs() {
  const refresh = needsRefreshSql();
  const [row] = await exec<Array<{ missing: number | string | null; stale: number | string | null }>>(
    `
      SELECT
        SUM(ewd.external_work_detail_id IS NULL) AS missing,
        SUM(ewd.external_work_detail_id IS NOT NULL AND ${refresh.sql}) AS stale
      FROM works w
      LEFT JOIN external_work_details ewd ON ewd.work_external_id = w.external_id
      WHERE w.external_id IS NOT NULL
        AND w.external_id <> 0
        AND w.is_deleted = 0
    `,
    refresh.params
  );

  logger.info(
    `Work details ETL: por actualizar (cambio de estado / fechas faltantes)=${Number(row?.stale ?? 0)} ` +
      `sin detalle=${Number(row?.missing ?? 0)}`
  );
}

async function fetchNextWorkRefs(lastWorkId: number, limit: number, filter: RefsFilter) {
  const safeLimit = Math.max(1, Math.trunc(limit));
  const join =
    filter === "all" ? "" : "LEFT JOIN external_work_details ewd ON ewd.work_external_id = w.external_id";
  let where = "";
  let params: number[] = [lastWorkId];

  if (filter === "missing") {
    where = "AND ewd.external_work_detail_id IS NULL";
  } else if (filter === "stale") {
    const refresh = needsRefreshSql();
    where = `AND ewd.external_work_detail_id IS NOT NULL AND ${refresh.sql}`;
    params = [lastWorkId, ...refresh.params];
  }

  return exec<WorkRef[]>(
    `
      SELECT w.work_id, w.external_id
      FROM works w
      ${join}
      WHERE w.work_id > ?
        AND w.external_id IS NOT NULL
        AND w.external_id <> 0
        AND w.is_deleted = 0
        ${where}
      ORDER BY w.work_id ASC
      LIMIT ${safeLimit}
    `,
    params
  );
}

export type WorkDetailsRunOptions = {
  /** que ordenes toma (default: missing) */
  filter?: RefsFilter;
  /** empezar despues de este work_id (para reanudar un barrido) */
  startAfterWorkId?: number;
  concurrency?: number;
  /** se revisa antes de cada lote; si devuelve true se detiene (completed=false) */
  shouldStop?: () => boolean;
  /** despues de guardar cada lote, con el ultimo work_id procesado */
  onBatchDone?: (lastWorkId: number) => void;
  label?: string;
};

export type WorkDetailsRunResult = {
  /** true = recorrio hasta que ya no hubo mas ordenes */
  completed: boolean;
  lastWorkId: number;
  attempted: number;
  persisted: number;
  failed: number;
};

export async function workDetailsEtl(opts: WorkDetailsRunOptions = {}): Promise<WorkDetailsRunResult> {
  const filter: RefsFilter = opts.filter ?? "missing";
  const batchSize = Math.max(1, Math.trunc(config.pending.batchSize));
  const concurrency = Math.max(1, Math.trunc(opts.concurrency ?? config.pending.concurrency));
  const hardLimit = Math.max(0, Math.trunc(config.pending.limit));
  const batchDelayMs = Math.max(0, Math.trunc(config.pending.batchDelayMs));
  const tag = opts.label ? ` [${opts.label}]` : "";

  let lastWorkId = Math.max(0, Math.trunc(opts.startAfterWorkId ?? 0));
  let attempted = 0;
  let fetched = 0;
  let failed = 0;
  let persisted = 0;
  let worksDateUpdated = 0;

  let completed = false;
  const startedAt = Date.now();
  let apiMs = 0;
  let dbMs = 0;

  // [VELOCIDAD] Mientras un lote se guarda en la BD, ya se esta pidiendo el siguiente a la API.
  // El guardado corre en una promesa que no rechaza (devuelve el error) para no provocar un
  // "unhandled rejection"; el error se relanza al esperarla.
  let pendingSave: Promise<unknown> | null = null;
  const waitPendingSave = async () => {
    if (!pendingSave) return;
    const err = await pendingSave;
    pendingSave = null;
    if (err) throw err;
  };

  const saveBatch = async (validDetails: DetailResult[], batchLastWorkId: number) => {
    const t0 = Date.now();
    await persistDetails(validDetails);
    persisted += validDetails.length;
    worksDateUpdated += await syncWorksEstimatedDelivery(uniqueNumbers(validDetails.map(getWorkExternalId)));
    dbMs += Date.now() - t0;

    const minutes = Math.max((Date.now() - startedAt) / 60000, 1 / 60);
    logger.info(
      `Work details ETL${tag}: progreso attempted=${attempted} fetched=${fetched} ` +
        `persisted=${persisted} failed=${failed} works_fecha_actualizada=${worksDateUpdated} ` +
        `lastWorkId=${batchLastWorkId} ritmo=${Math.round(persisted / minutes)}/min ` +
        `tiempo_api=${Math.round(apiMs / 1000)}s tiempo_bd=${Math.round(dbMs / 1000)}s`
    );

    opts.onBatchDone?.(batchLastWorkId);
  };

  logger.info(
    `Work details ETL${tag}: start ordenes=${filter} batchSize=${batchSize} concurrency=${concurrency} ` +
      `limit=${hardLimit || "ALL"} startAfterWorkId=${lastWorkId}`
  );

  try {
    while (!hardLimit || attempted < hardLimit) {
      if (opts.shouldStop?.()) break;

      const nextLimit = hardLimit ? Math.min(batchSize, hardLimit - attempted) : batchSize;
      const refs = await fetchNextWorkRefs(lastWorkId, nextLimit, filter);
      if (!refs.length) {
        completed = true;
        break;
      }

      lastWorkId = Math.max(...refs.map((ref) => Number(ref.work_id)));
      attempted += refs.length;

      logger.info(
        `Work details ETL: lote work_id>${refs[0].work_id - 1} refs=${refs.length} lastWorkId=${lastWorkId}`
      );

      const apiStart = Date.now();
      const details = await mapWithConcurrency(refs, concurrency, async (ref) => {
        try {
          const detail = await fetchWorkDetail(ref.external_id);
          if (!detail?.id) {
            logger.warn(`Work details ETL: detalle vacío external_id=${ref.external_id}`);
            failed += 1;
            return null;
          }

          fetched += 1;
          return { ref, detail };
        } catch (err: any) {
          failed += 1;
          logger.warn(
            `Work details ETL: no pude cargar detalle external_id=${ref.external_id} ` +
              `status=${err?.response?.status ?? err?.code ?? err?.message ?? "unknown"}`
          );
          return null;
        }
      });

      apiMs += Date.now() - apiStart;

      const validDetails = details.filter((item): item is DetailResult => item !== null);

      // el lote anterior tiene que quedar guardado antes de empezar a guardar este
      await waitPendingSave();
      pendingSave = saveBatch(validDetails, lastWorkId).then(
        () => null,
        (err) => err ?? new Error("Error guardando lote de detalles")
      );

      if (batchDelayMs) await sleep(batchDelayMs);
    }

    await waitPendingSave();
  } catch (err) {
    // terminar de guardar el lote en curso antes de salir con el error
    if (pendingSave) await pendingSave;
    throw err;
  }

  logger.info(
    `Work details ETL${tag}: ${completed ? "done" : "detenido"} attempted=${attempted} fetched=${fetched} ` +
      `persisted=${persisted} failed=${failed} works_fecha_actualizada=${worksDateUpdated} lastWorkId=${lastWorkId}`
  );

  return { completed, lastWorkId, attempted, persisted, failed };
}

export type PendingMaintenanceResult = {
  stale: WorkDetailsRunResult | null;
  missing: WorkDetailsRunResult;
};

// Igual que la vuelta normal del ETL de detalle (workDetailsSchedule.ts, WORK_DETAILS_ONLY_MISSING=1), sin el barrido:
// 1) primero las que cambiaron de estado o les falta fecha, 2) despues las ordenes nuevas sin detalle.
// onPass: avance para GET /status, al terminar cada pasada.
export async function runPendingMaintenance(
  onPass?: (pass: "stale" | "missing", result: WorkDetailsRunResult) => void
): Promise<PendingMaintenanceResult> {
  await logPendingRefs();
  const stale = config.pending.refreshChanged
    ? await workDetailsEtl({ filter: "stale", label: "por actualizar" })
    : null;
  if (stale) onPass?.("stale", stale);
  const missing = await workDetailsEtl({ filter: "missing", label: "sin detalle" });
  onPass?.("missing", missing);
  return { stale, missing };
}
