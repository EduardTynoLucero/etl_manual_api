// Clinicas (clients) + doctores (doctors, doctor_clients): carga COMPLETA desde la API.
// Es el mismo schedule_clinics_doctors_etl con ETL_MODE=PAGING_ONLY (clinicsToClientsEtl + doctorsEtl):
// mismas tablas STG (stg_clients, stg_doctors, stg_doctor_clients) y mismos upserts / soft deletes.
import { logger } from "./common/logger.js";
import { paginate } from "./common/pagination.js";
import { bulkInsert } from "./common/bulkInsert.js";
import { withTx } from "./common/tx.js";
import { detectPageBase } from "./common/pageBase.js";
import { SQL } from "./sql.js";
import { exec } from "../db.js";
import { config } from "../config.js";
import { fetchClinicsPageWithMeta } from "./api/clinicsApiClient.js";
import { fetchDoctorsPage, fetchDoctorsPageWithMeta } from "./api/doctorsApiClient.js";
import type { ClinicItem } from "../types/clinicsApi.js";
import type { DoctorItem } from "../types/doctorsApi.js";
import type { RunContext } from "../runs/context.js";

export type ClinicsDoctorsSummary = {
  clinics: number; // clinicas leidas de la API
  clinicsDeleted: number; // clinicas dadas de baja porque ya no vienen en la API
  doctors: number; // doctores leidos de la API
  doctorsDeleted: number; // doctores dados de baja porque ya no vienen en la API
  doctorClinicLinks: number; // relaciones doctor-clinica leidas
};

/** Avance para la barra de 0 a 100 del frontend (GET /status). */
export type ClinicsDoctorsProgress = (percent: number, message: string) => void;

// La API no dice cuantas paginas hay (solo has_more): el avance se estima con cuantas clinicas y doctores
// hay hoy en la BD. Leer de la API = 0..90%, guardar en la BD = 90..99%, el 100% lo pone el runner al terminar.
type Tracker = { expected: number; read: number; report: ClinicsDoctorsProgress };

function readPercent(t: Tracker) {
  return Math.min(90, Math.floor((t.read / Math.max(t.expected, t.read + 1)) * 90));
}

async function clinicsToClientsEtl(ctx: RunContext, t: Tracker) {
  logger.info(`[run ${ctx.runId}] Clinics->Clients ETL (STG): start`);
  let clinicsRead = 0;

  await exec(SQL.truncateStgClients);

  const pages = await paginate<ClinicItem>(
    async (page) => fetchClinicsPageWithMeta(page),
    async (items, page) => {
      logger.info(`[run ${ctx.runId}] Clinics->Clients ETL: page=${page} items=${items.length}`);
      if (!items.length) return;
      clinicsRead += items.length;
      t.read += items.length;
      t.report(readPercent(t), `Clínicas: página ${page}, ${items.length} leídas (van ${clinicsRead})`);

      const rows = items.map((c) => ([
        c.id ?? null,
        c.code ?? null,
        c.name ?? null,
        c.address ?? null,
        c.address2 ?? null,
        c.town ?? null,
        c.province ?? null,
        c.cp ?? null,
        c.email ?? null,
        c.phone ?? null,
        c.alternate_phone ?? null,
        c.mobile_phone ?? null,
        c.fax ?? null,
        c.web_page ?? null,
        c.fiscal_name ?? null,
        c.fiscal_address ?? null,
        c.fiscal_address2 ?? null,
        c.fiscal_town ?? null,
        c.fiscal_province ?? null,
        c.fiscal_cp ?? null,
        c.fiscal_number ?? null,
        c.iban ?? null,
        c.entry_date ?? null
      ]));

      await bulkInsert(
        "stg_clients",
        [
          "external_id","external_code","name","address","address2","town","province","cp","email",
          "phone","alternate_phone","mobile_phone","fax","web_page",
          "fiscal_name","fiscal_address","fiscal_address2","fiscal_town","fiscal_province",
          "fiscal_cp","fiscal_number","iban","entry_date_external"
        ],
        rows,
        500
      );
    },
    // paginacion automatica: corre hasta que la API ya no devuelve datos
    { pageStart: 0, label: "Clinics->Clients ETL" }
  );

  const [{ c: stgCount }] = await exec<Array<{ c: number }>>("SELECT COUNT(*) c FROM stg_clients");
  logger.info(`[run ${ctx.runId}] Clinics->Clients ETL: stg_clients=${stgCount}`);
  t.report(readPercent(t), `Clínicas: guardando ${stgCount} en la base de datos…`);

  const deleted = await withTx(async (conn) => {
    // [BAJAS] antes del upsert: clinicas de la API cuyo codigo lo tiene una fila dada de baja o creada en la
    // plataforma (ver SQL.releaseClientCodesFromInactive / SQL.adoptClientRowsByCode)
    const [released]: any = await conn.execute(SQL.releaseClientCodesFromInactive);
    const [adopted]: any = await conn.execute(SQL.adoptClientRowsByCode);
    if (released?.affectedRows || adopted?.affectedRows) {
      logger.warn(
        `Clinics->Clients ETL: codigos liberados de clinicas dadas de baja=${released?.affectedRows ?? 0} ` +
          `filas dadas de baja/sin external_id que pasan a su clinica de la API=${adopted?.affectedRows ?? 0} ` +
          `(quedan is_active=1, is_deleted=0)`
      );
    }

    await conn.execute(SQL.upsertClientsFromStg);

    if (config.clinicsDoctors.clientsSoftDelete) {
      // solo si la paginacion llego al final real de la API (si no, STG puede estar incompleta)
      if (!pages.complete) {
        logger.warn(`Clinics->Clients ETL: paginacion incompleta (fin=${pages.stopReason}). NO hago soft delete.`);
      } else {
        const [res]: any = await conn.execute(SQL.softDeleteClientsMissingFromStg);
        return Number(res?.affectedRows ?? 0);
      }
    }
    return 0;
  });

  logger.info(`[run ${ctx.runId}] Clinics->Clients ETL (STG): done`);
  t.report(
    readPercent(t),
    `Clínicas guardadas: ${stgCount}` + (deleted ? `, ${deleted} dadas de baja porque ya no vienen en la API` : "")
  );
  return { clinics: Number(stgCount), clinicsDeleted: deleted };
}

async function doctorsEtl(ctx: RunContext, t: Tracker) {
  logger.info(`[run ${ctx.runId}] Doctors ETL (STG): start`);
  let doctorsRead = 0;

  await exec(SQL.truncateStgDoctors);
  await exec(SQL.truncateStgDoctorClients);

  // carga completa (PAGING_ONLY): la API puede empezar en pagina 0 o 1
  const base = await detectPageBase((p) => fetchDoctorsPage(p));
  const pageStart = config.clinicsDoctors.doctorsPageFrom + base;

  logger.info(
    `[run ${ctx.runId}] Doctors ETL: mode=PAGING_ONLY base=${base} pages=${pageStart}..auto ` +
      `softDeleteGlobal=${config.clinicsDoctors.doctorsSoftDelete}`
  );

  let relations = 0;
  const pages = await paginate<DoctorItem>(
    async (page) => fetchDoctorsPageWithMeta(page),
    async (items, page) => {
      logger.info(`[run ${ctx.runId}] Doctors ETL: page=${page} items=${items.length}`);
      if (!items.length) return;
      doctorsRead += items.length;
      t.read += items.length;
      t.report(readPercent(t), `Doctores: página ${page}, ${items.length} leídos (van ${doctorsRead})`);

      // stg_doctors
      const doctorRows = items.map((d) => ([
        d.id ?? null,
        d.name ?? null,
        d.surname ?? null,
        d.nif ?? null,
        d.collegiate_member ?? null,
        d.address ?? null,
        d.address2 ?? null,
        d.town ?? null,
        d.province ?? null,
        d.cp ?? null,
        d.country ?? null,
        d.country_name ?? null,
        d.email ?? null,
        d.phone ?? null,
        d.alternate_phone ?? null,
        d.mobile_phone ?? null,
        d.fax ?? null,
        null
      ]));

      await bulkInsert(
        "stg_doctors",
        [
          "external_id","name","surname","nif","collegiate_member","address","address2","town","province",
          "cp","country","country_name","email","phone","alternate_phone","mobile_phone","fax","web_page"
        ],
        doctorRows,
        500
      );

      // stg_doctor_clients (relaciones)
      const relRows: any[][] = [];
      for (const d of items) {
        for (const cl of (d.clinics ?? [])) relRows.push([d.id ?? null, cl.id ?? null]);
      }
      if (relRows.length) {
        await bulkInsert("stg_doctor_clients", ["doctor_external_id", "client_external_id"], relRows, 1000);
        relations += relRows.length;
      }
    },
    {
      pageStart,
      label: "Doctors ETL",
    }
  );

  const [{ c: stgCount }] = await exec<Array<{ c: number }>>("SELECT COUNT(*) c FROM stg_doctors");
  logger.info(`[run ${ctx.runId}] Doctors ETL: stg_doctors=${stgCount}`);
  t.report(92, `Doctores: guardando ${stgCount} y ${relations} relaciones con clínicas en la base de datos…`);

  const deleted = await withTx(async (conn) => {
    await conn.execute(SQL.upsertDoctorsFromStg);
    await conn.execute(SQL.upsertDoctorClientsFromStg);
    await conn.execute(SQL.softDeleteDoctorClientsMissingForTouchedDoctors);

    if (config.clinicsDoctors.doctorsSoftDelete) {
      if (stgCount < 500) {
        logger.warn(`Doctors ETL: STG pequeña (${stgCount}). NO hago soft delete global.`);
      } else if (!pages.complete) {
        logger.warn(`Doctors ETL: paginacion incompleta (fin=${pages.stopReason}). NO hago soft delete global.`);
      } else {
        const [res]: any = await conn.execute(SQL.softDeleteDoctorsMissingFromStg);
        return Number(res?.affectedRows ?? 0);
      }
    }
    return 0;
  });

  logger.info(`[run ${ctx.runId}] Doctors ETL (STG): done`);
  t.report(
    99,
    `Doctores guardados: ${stgCount}` + (deleted ? `, ${deleted} dados de baja porque ya no vienen en la API` : "")
  );
  return { doctors: Number(stgCount), doctorsDeleted: deleted, doctorClinicLinks: relations };
}

/** Primero clinicas y despues doctores (doctor_clients necesita las clinicas), igual que el index.ts del ETL. */
export async function runClinicsDoctorsEtl(
  ctx: RunContext,
  report: ClinicsDoctorsProgress = () => {}
): Promise<ClinicsDoctorsSummary> {
  const [row] = await exec<Array<{ clinics: number | string; doctors: number | string }>>(`
    SELECT
      (SELECT COUNT(*) FROM clients WHERE external_id IS NOT NULL AND is_deleted = 0) AS clinics,
      (SELECT COUNT(*) FROM doctors WHERE is_deleted = 0) AS doctors
  `);
  const t: Tracker = { expected: Number(row?.clinics ?? 0) + Number(row?.doctors ?? 0), read: 0, report };
  report(0, `Leyendo clínicas de la API (hoy hay ${Number(row?.clinics ?? 0)} clínicas y ${Number(row?.doctors ?? 0)} doctores)…`);

  const clinics = await clinicsToClientsEtl(ctx, t);
  report(readPercent(t), "Leyendo doctores de la API…");
  const doctors = await doctorsEtl(ctx, t);
  return { ...clinics, ...doctors };
}
