// Validaciones de dependencias para las ordenes (copia de schedule_works_order_list_etl/src/etl/worksDependencies.ts).
// clients/doctors los carga el ETL de clinicas/doctores (o POST /api/etl-manual/doctors), asi que aqui se
// valida que existan antes de tocar works.
import { exec } from "../db.js";
import { withTx } from "./common/tx.js";
import { SQL } from "./sql.js";
import { logger } from "./common/logger.js";

/**
 * Chequeo previo: si clients o doctors estan vacios (p. ej. BD nueva y el ETL de
 * clinicas/doctores todavia no ha corrido) no se procesan works en esta corrida.
 */
export async function ensureWorkDependenciesReady(): Promise<boolean> {
  const [row] = await exec<Array<{ has_clients: number; has_doctors: number }>>(SQL.catalogsReady);
  const hasClients = Number(row?.has_clients ?? 0) === 1;
  const hasDoctors = Number(row?.has_doctors ?? 0) === 1;

  if (!hasClients || !hasDoctors) {
    logger.warn(
      `Works ETL: dependencias no listas (clients=${hasClients ? "OK" : "VACIO"} doctors=${hasDoctors ? "OK" : "VACIO"}). ` +
        `Primero carga clinicas y doctores.`
    );
    return false;
  }

  return true;
}

/**
 * Antes del upsert: reporta works en STG cuya clinica/doctor aun no existe localmente.
 * - Clinica faltante: el upsert NO inserta ese work (regla original, protege la FK) y
 *   no se guarda en esta ejecucion.
 * - Doctor faltante: el work entra con doctor_id NULL (regla original) y luego
 *   relinkWorkReferences() completa doctor_id cuando el doctor ya existe.
 */
export async function logMissingWorkDependencies(context: string): Promise<{ worksMissingClinic: number }> {
  const [summary] = await exec<
    Array<{
      works_missing_clinic: number;
      missing_clinics: number;
      works_missing_doctor: number;
      missing_doctors: number;
    }>
  >(SQL.stgWorksMissingDependencies);

  const worksMissingClinic = Number(summary?.works_missing_clinic ?? 0);
  const worksMissingDoctor = Number(summary?.works_missing_doctor ?? 0);

  if (worksMissingClinic > 0) {
    const sample = await exec<Array<{ id: number }>>(SQL.stgMissingClinicIdsSample);
    logger.warn(
      `Works ETL (${context}): ${worksMissingClinic} works omitidos porque su clinica aun no existe ` +
        `(clinicas faltantes=${Number(summary?.missing_clinics ?? 0)} ej=${sample.map((r) => r.id).join(",")}). ` +
        `No se guardan: carga clinicas/doctores y vuelve a correr ese dia.`
    );
  }

  if (worksMissingDoctor > 0) {
    const sample = await exec<Array<{ id: number }>>(SQL.stgMissingDoctorIdsSample);
    logger.warn(
      `Works ETL (${context}): ${worksMissingDoctor} works con doctor aun no cargado ` +
        `(doctores faltantes=${Number(summary?.missing_doctors ?? 0)} ej=${sample.map((r) => r.id).join(",")}). ` +
        `Entran con doctor_id NULL y se re-vinculan cuando llegue el doctor.`
    );
  }

  return { worksMissingClinic };
}

/**
 * Despues del upsert: completa doctor_id / clinic_id de works que entraron antes
 * que su doctor/clinica (quedaron en NULL pero ya tienen el external_id guardado).
 */
export async function relinkWorkReferences() {
  const { doctors, clinics } = await withTx(async (conn) => {
    const [doctorsRes] = await conn.execute(SQL.relinkWorksDoctors);
    const [clinicsRes] = await conn.execute(SQL.relinkWorksClinics);
    return {
      doctors: Number(doctorsRes?.affectedRows ?? 0),
      clinics: Number(clinicsRes?.affectedRows ?? 0),
    };
  });

  if (doctors || clinics) {
    logger.info(`Works ETL: re-vinculados doctor_id=${doctors} clinic_id=${clinics}`);
  }
}
