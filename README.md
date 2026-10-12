# etl_manual_api

Los mismos 3 ETLs (`schedule_clinics_doctors_etl`, `schedule_works_order_list_etl`, `schedule_works_order_details_etl`),
pero en vez de correr solos en un ciclo, se ejecutan **cuando el frontend los llama**, con 2 endpoints.
**No crea tablas**: usa las mismas tablas STG (`stg_clients`, `stg_doctors`, `stg_doctor_clients`, `stg_works`,
`stg_patients`) y el mismo SQL de los ETLs.

| Endpoint | Que hace |
|---|---|
| `POST /api/etl-manual/doctors` | ETL de clinicas y doctores completo: `/clinics` y `/doctors` todas las paginas (igual que `ETL_MODE=PAGING_ONLY`). |
| `POST /api/etl-manual/works` | Ordenes por fecha. Body: `{ "dateFrom": "2026-10-01", "dateTo": "2026-10-10" }` |

## Ordenes por fecha

Por cada dia del rango, del primero al ultimo:

1. **Listado**: `/works?updated_since=<dia>T00:00:00-06:00&page=0`, `page=1`, ... hasta que la API ya no devuelve datos.
2. Por cada pagina, por cada orden: **`/works/{id}`** (el detalle / mantenimiento).
   - Con el listado + el detalle se guardan `works` y `patients` (igual que `schedule_works_order_list_etl`).
   - Con el detalle se guardan `external_work_details`, `external_work_tasks`, `external_work_tags`,
     `external_work_products`, `external_work_lots` y catalogos (igual que `schedule_works_order_details_etl`),
     y se copia la fecha de envio a `works.estimated_delivery`.
3. Termina el dia, espera `WORKS_RANGE_DAY_PAUSE_MS` y sigue con el siguiente.
4. Al terminar todos los dias, **pendientes** (lo que hacian los ETLs en cada vuelta, **sin el barrido completo**):
   - Backfill de pacientes (`schedule_works_order_list_etl`): ordenes de `works` sin `patient_id` -> `/works/{id}`
     (hasta `WORKS_BACKFILL_MISSING_PATIENTS_LIMIT`; no repite la misma orden antes de `WORKS_BACKFILL_RETRY_HOURS`).
   - Mantenimiento (`schedule_works_order_details_etl` con `WORK_DETAILS_ONLY_MISSING=1`): primero las ordenes
     **por actualizar** (status o finish_date distintos al detalle, o sin fecha de envio / estimada en los ultimos
     `WORK_DETAILS_REFRESH_MISSING_DATES_DAYS` dias) y despues las ordenes **sin detalle**.

Ejemplo: del 01 al 03 de octubre corre `updated_since=2026-10-01...` (todas sus paginas y detalles), despues
`updated_since=2026-10-02...` y despues `updated_since=2026-10-03...`.

- Solo corre una ejecucion a la vez (doctores u ordenes). Si ya hay una, responde **409**.
- Las ordenes cuya clinica no existe en `clients` no se guardan (igual que el ETL del listado).
- Si los ETLs programados siguen corriendo al mismo tiempo, comparten las tablas STG y los dos llaman a la API.

## Instalacion

Crear `.env` (ver abajo) y:

```bash
npm install
npm run build
npm start
```

### .env

```ini
PORT=3810

# API externa (los mismos valores que los ETLs)
API_BASE_URL=
API_TOKEN=

# BD de la plataforma (la misma de los ETLs)
DB_HOST=
DB_PORT=3306
DB_USER=
DB_PASS=
DB_NAME=

TZ=America/Guatemala

# Mismo JWT_SECRET que el backend de la plataforma (el frontend manda el mismo token del login)
JWT_SECRET=
# Origen(es) del frontend, separados por coma
FRONTEND_URL=https://dev.digitalabsgt.com
# Opcional: codigo de permiso (MODULO.SUBMODULO.ACCION). Vacio = basta con el token
ETL_PERMISSION=

# Clinicas/doctores: dar de baja lo que ya no viene en la API (igual que el .env del ETL)
CLIENTS_ENABLE_SOFT_DELETE=1
DOCTORS_ENABLE_SOFT_DELETE=1

# Ordenes por fecha
WORKS_RANGE_MAX_DAYS=31
WORKS_RANGE_DETAIL_CONCURRENCY=4
WORKS_RANGE_PAGE_DELAY_MS=250
WORKS_RANGE_DAY_PAUSE_MS=5000
WORK_DETAILS_SYNC_WORKS_ESTIMATED_DELIVERY=1

# Pendientes al terminar los dias (mismas variables que los ETLs)
WORKS_BACKFILL_MISSING_PATIENTS=1
WORKS_BACKFILL_MISSING_PATIENTS_LIMIT=500
WORKS_BACKFILL_RETRY_HOURS=6
WORK_DETAILS_REFRESH_CHANGED=1
WORK_DETAILS_REFRESH_MIN_AGE_MINUTES=15
WORK_DETAILS_REFRESH_MISSING_DATES_DAYS=7
WORK_DETAILS_BATCH_SIZE=100
WORK_DETAILS_CONCURRENCY=2
WORK_DETAILS_LIMIT=0
WORK_DETAILS_BATCH_DELAY_MS=250
```

## Uso desde el frontend

Header: `Authorization: Bearer <token del login de la plataforma>`. Respuestas `{ success, message?, data }`.

- `POST /api/etl-manual/doctors` -> **202** y la carga sigue en segundo plano.
- `POST /api/etl-manual/works` con `{ dateFrom, dateTo }` -> **202** y sigue en segundo plano.
  400 si las fechas no son `YYYY-MM-DD`, si fin < inicio, si fin > hoy o si pasa de `WORKS_RANGE_MAX_DAYS` dias.
- `GET /api/etl-manual/status` (opcional, para mostrar el avance): `running` (la que esta corriendo, o `null`) y
  `last.clinicsDoctors` / `last.works` (la ultima de cada una), con el avance por dia. Se guarda en memoria:
  si el servicio se reinicia, se pierde (lo que ya se guardo en la BD queda).
  Las dos cargas traen ademas `progress` (`percent` de 0 a 100 y `message`) y `log` (las mismas lineas que
  salen en la consola durante esa carga) para el modal del frontend. La API no dice cuantas paginas hay, asi que el porcentaje es
  aproximado: en doctores se estima con cuantas clinicas y doctores hay hoy en la BD; en ordenes cada dia es una parte
  igual del 0-90% (dentro del dia, con las paginas del dia anterior) y los pendientes son el 90-99%.

Ejemplo de `last.works`:

```json
{
  "id": 2, "type": "WORKS_BY_DAY", "dateFrom": "2026-10-01", "dateTo": "2026-10-03",
  "status": "DONE", "totalDays": 3, "daysDone": 3, "currentDay": null, "errorMessage": null,
  "summary": { "pages": 30, "orders": 720, "detailsFetched": 720, "detailsFailed": 0, "worksSaved": 714,
               "worksMissingClinic": 6, "detailsSaved": 714, "deliveryDatesUpdated": 476 },
  "days": [
    { "day": "2026-10-01", "status": "DONE", "updatedSince": "2026-10-01T00:00:00-06:00", "pages": 12, "orders": 300,
      "detailsFetched": 300, "detailsFailed": 0, "worksSaved": 294, "worksMissingClinic": 6, "detailsSaved": 294 }
  ],
  "pending": {
    "status": "DONE",
    "patients": { "consulted": 18, "fetched": 18, "failed": 0, "applied": 18 },
    "stale": { "completed": true, "lastWorkId": 268, "attempted": 9, "persisted": 9, "failed": 0 },
    "missing": { "completed": true, "lastWorkId": 206, "attempted": 13, "persisted": 13, "failed": 0 }
  }
}
```

Estados: ejecucion `RUNNING`, `DONE`, `ERROR`; dia y `pending`: `PENDING`, `RUNNING`, `DONE`, `ERROR`, `NOT_RUN`.

## Codigo

| Archivo | Que tiene |
|---|---|
| `src/server.ts`, `src/http/routes.ts` | Express y los endpoints |
| `src/http/auth.ts` | JWT (copia del middleware del backend) |
| `src/runs/runner.ts` | Una ejecucion a la vez, dias del rango |
| `src/etl/clinicsDoctorsEtl.ts` | `clinicsToClientsEtl` + `doctorsEtl` de `schedule_clinics_doctors_etl` |
| `src/etl/worksByDayEtl.ts` | Un dia: listado (`worksEtl` de `schedule_works_order_list_etl`) + detalle de cada orden, y el backfill de pacientes |
| `src/etl/maintenanceEtl.ts` | Pendientes de `schedule_works_order_details_etl` (por actualizar + sin detalle), sin el barrido |
| `src/etl/detailStore.ts` | Guardado del detalle (`persistDetails` de `schedule_works_order_details_etl`) |
| `src/etl/sql.ts` | SQL de los ETLs tal cual |

Si cambias un upsert o el guardado del detalle en los ETLs, cambialo tambien aqui.
