import dotenv from "dotenv";
dotenv.config();

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function toBool(v: any, def = false) {
  if (v === undefined || v === null || v === "") return def;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y";
}

// Acepta DB_PASS o DB_PASSWORD y permite contraseña vacía (MySQL local sin password).
function dbPassword(): string {
  const v = process.env.DB_PASS ?? process.env.DB_PASSWORD;
  if (v === undefined) throw new Error("Missing env var: DB_PASS (o DB_PASSWORD)");
  return v;
}

function toNum(v: any, def: number) {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : def;
}

function toList(v: any, def: string[]) {
  const items = String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : def;
}

export const config = {
  port: toNum(process.env.PORT, 3810),

  api: {
    baseUrl: must("API_BASE_URL"),
    token: must("API_TOKEN"),
  },
  db: {
    host: must("DB_HOST"),
    user: must("DB_USER"),
    password: dbPassword(),
    database: must("DB_NAME"),
    port: Number(process.env.DB_PORT ?? "3306"),
    // [RAM] limites del pool (ver src/db.ts)
    poolLimit: Math.max(2, toNum(process.env.DB_POOL_LIMIT, 5)),
    poolMaxIdle: Math.max(0, toNum(process.env.DB_POOL_MAX_IDLE, 2)),
    maxPreparedStatements: Math.max(1, toNum(process.env.DB_MAX_PREPARED_STATEMENTS, 50)),
  },
  tz: process.env.TZ ?? "America/Guatemala",

  // Seguridad: el mismo JWT que entrega el backend de la plataforma (mismo JWT_SECRET)
  auth: {
    jwtSecret: must("JWT_SECRET"),
    // opcional: codigo de permiso de la plataforma (MODULO.SUBMODULO.ACCION). Vacio = solo se valida el token.
    permission: (process.env.ETL_PERMISSION ?? "").trim(),
  },
  // origenes del frontend que pueden llamar a esta API (separados por coma)
  corsOrigins: toList(process.env.FRONTEND_URL, ["https://dev.digitalabsgt.com"]),

  clinicsDoctors: {
    // igual que schedule_clinics_doctors_etl con ETL_MODE=PAGING_ONLY: baja (soft delete) lo que ya no viene en la API,
    // solo si la paginacion llego al final
    clientsSoftDelete: toBool(process.env.CLIENTS_ENABLE_SOFT_DELETE, true),
    doctorsSoftDelete: toBool(process.env.DOCTORS_ENABLE_SOFT_DELETE, true),
    doctorsPageFrom: toNum(process.env.DOCTORS_PAGE_FROM, 0),
  },

  works: {
    // maximo de dias que se pueden pedir en una sola ejecucion
    maxDays: Math.max(1, toNum(process.env.WORKS_RANGE_MAX_DAYS, 31)),
    // consultas a /works/{id} al mismo tiempo (fijo, sin subir solo, para no saturar la API)
    detailConcurrency: Math.max(1, toNum(process.env.WORKS_RANGE_DETAIL_CONCURRENCY, 4)),
    // pausa entre paginas del listado y entre un dia y el siguiente (ms)
    pageDelayMs: Math.max(0, toNum(process.env.WORKS_RANGE_PAGE_DELAY_MS, 250)),
    dayPauseMs: Math.max(0, toNum(process.env.WORKS_RANGE_DAY_PAUSE_MS, 5000)),
    // copia la fecha de envio del detalle a works.estimated_delivery (igual que el ETL de mantenimiento)
    syncWorksEstimatedDelivery: toBool(process.env.WORK_DETAILS_SYNC_WORKS_ESTIMATED_DELIVERY, true),
  },

  // Al terminar los dias de POST /works: lo que hacian los ETLs sobre la tabla works (mismas variables que sus .env)
  pending: {
    // backfill de pacientes (schedule_works_order_list_etl): ordenes de works sin paciente -> /works/{id}
    backfillMissingPatients: toBool(process.env.WORKS_BACKFILL_MISSING_PATIENTS, true),
    backfillMissingPatientsLimit: toNum(process.env.WORKS_BACKFILL_MISSING_PATIENTS_LIMIT, 500),
    // no reintentar la misma orden antes de N horas
    backfillRetryHours: Math.max(0, toNum(process.env.WORKS_BACKFILL_RETRY_HOURS, 6)),

    // mantenimiento (schedule_works_order_details_etl con WORK_DETAILS_ONLY_MISSING=1), SIN el barrido completo:
    // 1) por actualizar (WORK_DETAILS_REFRESH_CHANGED=1)  2) sin detalle
    batchSize: toNum(process.env.WORK_DETAILS_BATCH_SIZE, 100),
    concurrency: toNum(process.env.WORK_DETAILS_CONCURRENCY, 2),
    limit: toNum(process.env.WORK_DETAILS_LIMIT, 0),
    refreshChanged: toBool(process.env.WORK_DETAILS_REFRESH_CHANGED, true),
    // No vuelve a pedir la misma orden si su detalle se guardo hace menos de estos minutos.
    refreshMinAgeMinutes: Math.max(0, toNum(process.env.WORK_DETAILS_REFRESH_MIN_AGE_MINUTES, 15)),
    // Tambien vuelve a pedir: terminadas en los ultimos N dias sin fecha de envio y creadas en los ultimos N dias
    // sin ninguna fecha estimada. 0 = no.
    refreshMissingDatesDays: Math.max(0, toNum(process.env.WORK_DETAILS_REFRESH_MISSING_DATES_DAYS, 7)),
    batchDelayMs: toNum(process.env.WORK_DETAILS_BATCH_DELAY_MS, 250),
  },
};
