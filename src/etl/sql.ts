// SQL de los ETLs, copiado TAL CUAL (mismas tablas STG y mismos upserts):
// - clinicas/doctores: schedule_clinics_doctors_etl/src/etl/common/sql.ts
// - ordenes:           schedule_works_order_list_etl/src/etl/common/sql.ts
// Si cambias un upsert en los ETLs, cambialo tambien aqui.
export const SQL = {
  /* ============================
     TRUNCATE STG
     ============================ */
  truncateStgClients: `TRUNCATE TABLE stg_clients;`,
  truncateStgDoctors: `TRUNCATE TABLE stg_doctors;`,
  truncateStgDoctorClients: `TRUNCATE TABLE stg_doctor_clients;`,

  /* ============================
     UPSERT CLIENTS (reactiva)
     ============================ */
  upsertClientsFromStg: `
    INSERT INTO clients (
      external_id, external_code, name, address, address2, town, province, cp, email,
      phone, alternate_phone, mobile_phone, fax, web_page, fiscal_name, fiscal_address,
      fiscal_address2, fiscal_town, fiscal_province, fiscal_cp, fiscal_number, iban,
      entry_date_external,
      is_active, is_deleted, created_at, created_by, updated_at, updated_by
    )
    SELECT
      s.external_id, s.external_code, s.name, s.address, s.address2, s.town, s.province, s.cp, s.email,
      s.phone, s.alternate_phone, s.mobile_phone, s.fax, s.web_page, s.fiscal_name, s.fiscal_address,
      s.fiscal_address2, s.fiscal_town, s.fiscal_province, s.fiscal_cp, s.fiscal_number, s.iban,
      s.entry_date_external,
      1, 0, NOW(), 'etl', NOW(), 'etl'
    FROM stg_clients s
    WHERE s.external_id IS NOT NULL
    ON DUPLICATE KEY UPDATE
      external_code = VALUES(external_code),
      name = VALUES(name),
      address = VALUES(address),
      address2 = VALUES(address2),
      town = VALUES(town),
      province = VALUES(province),
      cp = VALUES(cp),
      email = VALUES(email),
      phone = VALUES(phone),
      alternate_phone = VALUES(alternate_phone),
      mobile_phone = VALUES(mobile_phone),
      fax = VALUES(fax),
      web_page = VALUES(web_page),
      fiscal_name = VALUES(fiscal_name),
      fiscal_address = VALUES(fiscal_address),
      fiscal_address2 = VALUES(fiscal_address2),
      fiscal_town = VALUES(fiscal_town),
      fiscal_province = VALUES(fiscal_province),
      fiscal_cp = VALUES(fiscal_cp),
      fiscal_number = VALUES(fiscal_number),
      iban = VALUES(iban),
      entry_date_external = VALUES(entry_date_external),
      is_active = 1,
      is_deleted = 0,
      updated_at = NOW(),
      updated_by = 'etl';
  `,

  /* ============================
     [BAJAS] CLINICAS DADAS DE BAJA O CREADAS EN LA PLATAFORMA
     - clients tiene llave unica en external_code. Si la clinica que trae la API tiene el mismo codigo que una
       fila dada de baja (is_active = 0 / is_deleted = 1) o creada en la plataforma (external_id NULL), el upsert
       actualizaba ESA fila pero sin ponerle el external_id de la API: la clinica nunca quedaba con su id, el soft
       delete la volvia a dar de baja y las ordenes de esa clinica se omitian.
     - Solo se comparan codigos que no hayan sido liberados antes ('-baja-').
     ============================ */

  // 1) La clinica de la API ya tiene su propia fila, pero otra fila dada de baja tiene su mismo codigo:
  //    se libera el codigo de la fila dada de baja (<codigo>-baja-<client_id>) para que el upsert no choque.
  releaseClientCodesFromInactive: `
    UPDATE clients c
    JOIN stg_clients s
      ON s.external_code = c.external_code
    JOIN clients own
      ON own.external_id = s.external_id
     AND own.client_id <> c.client_id
    SET c.external_code = LEFT(CONCAT(c.external_code, '-baja-', c.client_id), 50),
        c.updated_at = NOW(),
        c.updated_by = 'etl'
    WHERE s.external_id IS NOT NULL
      AND c.external_code NOT LIKE '%-baja-%'
      AND (c.is_deleted = 1 OR c.is_active = 0);
  `,

  // 2) La clinica de la API NO tiene fila propia y su codigo lo tiene una fila dada de baja o sin external_id
  //    (y el id viejo de esa fila ya no viene en la API): esa fila pasa a ser la clinica de la API (se le pone
  //    su external_id). Despues el upsert la actualiza y la deja is_active = 1, is_deleted = 0.
  adoptClientRowsByCode: `
    UPDATE clients c
    JOIN stg_clients s
      ON s.external_code = c.external_code
    LEFT JOIN clients own
      ON own.external_id = s.external_id
    LEFT JOIN stg_clients still
      ON still.external_id = c.external_id
    SET c.external_id = s.external_id,
        c.updated_at = NOW(),
        c.updated_by = 'etl'
    WHERE s.external_id IS NOT NULL
      AND own.client_id IS NULL
      AND still.external_id IS NULL
      AND c.external_code NOT LIKE '%-baja-%'
      AND (c.external_id IS NULL OR c.is_deleted = 1 OR c.is_active = 0);
  `,

  softDeleteClientsMissingFromStg: `
    UPDATE clients c
    LEFT JOIN (
      SELECT DISTINCT external_id
      FROM stg_clients
      WHERE external_id IS NOT NULL
    ) s ON s.external_id = c.external_id
    SET c.is_active = 0,
        c.is_deleted = 1,
        c.updated_at = NOW(),
        c.updated_by = 'etl'
    WHERE s.external_id IS NULL
      AND c.is_deleted = 0;
  `,

  /* ============================
     UPSERT DOCTORS (reactiva)
     ============================ */
  upsertDoctorsFromStg: `
    INSERT INTO doctors (
      external_id, name, surname, nif, collegiate_member,
      address, address2, town, province, cp,
      country, country_name,
      email, phone, alternate_phone, mobile_phone, fax, web_page,
      is_active, is_deleted, created_at, created_by, updated_at, updated_by
    )
    SELECT
      s.external_id, s.name, s.surname, s.nif, s.collegiate_member,
      s.address, s.address2, s.town, s.province, s.cp,
      s.country, s.country_name,
      s.email, s.phone, s.alternate_phone, s.mobile_phone, s.fax, s.web_page,
      1, 0, NOW(), 'etl', NOW(), 'etl'
    FROM stg_doctors s
    WHERE s.external_id IS NOT NULL
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      surname = VALUES(surname),
      nif = VALUES(nif),
      collegiate_member = VALUES(collegiate_member),
      address = VALUES(address),
      address2 = VALUES(address2),
      town = VALUES(town),
      province = VALUES(province),
      cp = VALUES(cp),
      country = VALUES(country),
      country_name = VALUES(country_name),
      email = VALUES(email),
      phone = VALUES(phone),
      alternate_phone = VALUES(alternate_phone),
      mobile_phone = VALUES(mobile_phone),
      fax = VALUES(fax),
      web_page = VALUES(web_page),
      is_active = 1,
      is_deleted = 0,
      updated_at = NOW(),
      updated_by = 'etl';
  `,

  softDeleteDoctorsMissingFromStg: `
    UPDATE doctors d
    LEFT JOIN (
      SELECT DISTINCT external_id
      FROM stg_doctors
      WHERE external_id IS NOT NULL
    ) s ON s.external_id = d.external_id
    SET d.is_active = 0,
        d.is_deleted = 1,
        d.updated_at = NOW(),
        d.updated_by = 'etl'
    WHERE s.external_id IS NULL
      AND d.is_deleted = 0;
  `,

  /* ============================
     UPSERT DOCTOR_CLIENTS (reactiva)
     - usa doctors/clients reales para resolver doctor_id/client_id
     ============================ */
  upsertDoctorClientsFromStg: `
    INSERT INTO doctor_clients (
      doctor_external_id, doctor_id,
      client_external_id, client_id,
      is_active, is_deleted, created_at, created_by, updated_at, updated_by
    )
    SELECT
      s.doctor_external_id,
      d.doctor_id,
      s.client_external_id,
      c.client_id,
      1, 0, NOW(), 'etl', NOW(), 'etl'
    FROM stg_doctor_clients s
    JOIN doctors d ON d.external_id = s.doctor_external_id
    JOIN clients c ON c.external_id = s.client_external_id
    WHERE s.doctor_external_id IS NOT NULL
      AND s.client_external_id IS NOT NULL
    ON DUPLICATE KEY UPDATE
      doctor_id = VALUES(doctor_id),
      client_id = VALUES(client_id),
      is_active = 1,
      is_deleted = 0,
      updated_at = NOW(),
      updated_by = 'etl';
  `,

  // Soft delete SOLO para doctores tocados en esta corrida (seguro para incremental)
  softDeleteDoctorClientsMissingForTouchedDoctors: `
    UPDATE doctor_clients dc
    JOIN (
      SELECT DISTINCT doctor_external_id
      FROM stg_doctor_clients
      WHERE doctor_external_id IS NOT NULL
    ) t ON t.doctor_external_id = dc.doctor_external_id
    LEFT JOIN stg_doctor_clients s
      ON s.doctor_external_id = dc.doctor_external_id
     AND s.client_external_id = dc.client_external_id
    SET dc.is_active = 0,
        dc.is_deleted = 1,
        dc.updated_at = NOW(),
        dc.updated_by = 'etl'
    WHERE s.doctor_external_id IS NULL
      AND dc.is_deleted = 0;
  `,

  /* =====================================================================
     ORDENES (schedule_works_order_list_etl)
     ===================================================================== */
  /* ============================
     TRUNCATE STG
     ============================ */
  truncateStgWorks: `TRUNCATE TABLE stg_works;`,
  truncateStgPatients: `TRUNCATE TABLE stg_patients;`,

  /* ============================
     UPSERT PATIENTS (reactiva)
     - la API no trae patient.id; patient_key evita duplicados razonables
     ============================ */
  upsertPatientsFromStg: `
    INSERT INTO patients (
      patient_key, name, age, sex, sex_name,
      is_active, created_at, created_by, updated_at, updated_by
    )
    SELECT
      s.patient_key,
      MAX(s.name) AS name,
      MAX(s.age) AS age,
      MAX(NULLIF(s.sex, '')) AS sex,
      MAX(NULLIF(s.sex_name, '')) AS sex_name,
      1, NOW(), 'etl', NOW(), 'etl'
    FROM stg_patients s
    WHERE s.patient_key IS NOT NULL
      AND s.patient_key <> ''
      AND s.name IS NOT NULL
      AND s.name <> ''
    GROUP BY s.patient_key
    ON DUPLICATE KEY UPDATE
      patient_key = COALESCE(patient_key, VALUES(patient_key)),
      name = VALUES(name),
      age = VALUES(age),
      sex = VALUES(sex),
      sex_name = VALUES(sex_name),
      is_active = 1,
      updated_at = NOW(),
      updated_by = 'etl';
  `,

  /* ============================
     UPSERT WORKS (reactiva)
     ============================ */

     upsertWorksFromStg: `
  INSERT INTO works (
    external_id, code, box, created_at_api, accepted_date, estimated_delivery, finish_date,
    status, status_name,
    clinic_id, clinic_external_id,
    doctor_id, doctor_external_id,
    patient_id,
    is_active, is_deleted, created_at, created_by, updated_at, updated_by
  )
  SELECT
    s.external_id,
    s.code,
    s.box,
    s.created_at_api,
    s.accepted_date,
    -- [ENVIO] = delivery_note_date del detalle (lo calcula el ETL); NULL si la orden aun no se envia
    s.estimated_delivery,
    s.finish_date,
    s.status,
    s.status_name,

    c.client_id,             -- ✅ clinic_id real
    s.clinic_external_id,    -- ✅ external

    d.doctor_id,             -- ✅ doctor_id real (puede quedar NULL si no existe)
    s.doctor_external_id,

    COALESCE(p_key.patient_id, p_name.patient_id),
    1, 0, NOW(), 'etl', NOW(), 'etl'
  FROM stg_works s
  LEFT JOIN clients c
    ON c.external_id = s.clinic_external_id
  LEFT JOIN doctors d
    ON d.external_id = s.doctor_external_id
  LEFT JOIN (
    SELECT
      work_external_id,
      MAX(patient_key) AS patient_key,
      MAX(name) AS patient_name
    FROM stg_patients
    WHERE work_external_id IS NOT NULL
      AND patient_key IS NOT NULL
      AND patient_key <> ''
    GROUP BY work_external_id
  ) sp ON sp.work_external_id = s.external_id
  LEFT JOIN patients p_key
    ON p_key.patient_key = sp.patient_key
  LEFT JOIN patients p_name
    ON p_key.patient_id IS NULL
   AND p_name.name = sp.patient_name
  WHERE s.external_id IS NOT NULL

    -- ✅ IMPORTANTÍSIMO: si NO existe la clínica local, NO insertes/actualices ese work
    -- porque rompería la FK
    AND (s.clinic_external_id IS NULL OR c.client_id IS NOT NULL)

  ON DUPLICATE KEY UPDATE
    code = VALUES(code),
    box = VALUES(box),
    created_at_api = VALUES(created_at_api),
    accepted_date = VALUES(accepted_date),
    estimated_delivery = VALUES(estimated_delivery),
    finish_date = VALUES(finish_date),
    status = VALUES(status),
    status_name = VALUES(status_name),

    clinic_id = VALUES(clinic_id),
    clinic_external_id = VALUES(clinic_external_id),

    doctor_id = VALUES(doctor_id),
    doctor_external_id = VALUES(doctor_external_id),

    patient_id = COALESCE(VALUES(patient_id), works.patient_id),

    is_active = 1,
    is_deleted = 0,
    updated_at = NOW(),
    updated_by = 'etl';
`,


  softDeleteWorksMissingFromStg: `
    UPDATE works w
    LEFT JOIN (
      SELECT DISTINCT external_id
      FROM stg_works
      WHERE external_id IS NOT NULL
    ) s ON s.external_id = w.external_id
    SET w.is_active = 0,
        w.is_deleted = 1,
        w.updated_at = NOW(),
        w.updated_by = 'etl'
    WHERE s.external_id IS NULL
      AND w.is_deleted = 0;
  `,

  /* ============================
     [SPLIT] VALIDACIONES DE DEPENDENCIAS
     - clients / doctors ahora los carga otro repo (schedule_clinics_doctors_etl),
       asi que antes de tocar works se valida que existan.
     ============================ */
  catalogsReady: `
    SELECT
      EXISTS (SELECT 1 FROM clients LIMIT 1) AS has_clients,
      EXISTS (SELECT 1 FROM doctors LIMIT 1) AS has_doctors;
  `,

  // Resumen de works en STG cuya clinica / doctor todavia no existe localmente
  stgWorksMissingDependencies: `
    SELECT
      COUNT(DISTINCT CASE WHEN s.clinic_external_id IS NOT NULL AND c.client_id IS NULL THEN s.external_id END) AS works_missing_clinic,
      COUNT(DISTINCT CASE WHEN s.clinic_external_id IS NOT NULL AND c.client_id IS NULL THEN s.clinic_external_id END) AS missing_clinics,
      COUNT(DISTINCT CASE WHEN s.doctor_external_id IS NOT NULL AND d.doctor_id IS NULL THEN s.external_id END) AS works_missing_doctor,
      COUNT(DISTINCT CASE WHEN s.doctor_external_id IS NOT NULL AND d.doctor_id IS NULL THEN s.doctor_external_id END) AS missing_doctors
    FROM stg_works s
    LEFT JOIN clients c
      ON c.external_id = s.clinic_external_id
    LEFT JOIN doctors d
      ON d.external_id = s.doctor_external_id
    WHERE s.external_id IS NOT NULL;
  `,

  stgMissingClinicIdsSample: `
    SELECT DISTINCT s.clinic_external_id AS id
    FROM stg_works s
    LEFT JOIN clients c
      ON c.external_id = s.clinic_external_id
    WHERE s.external_id IS NOT NULL
      AND s.clinic_external_id IS NOT NULL
      AND c.client_id IS NULL
    LIMIT 20;
  `,

  stgMissingDoctorIdsSample: `
    SELECT DISTINCT s.doctor_external_id AS id
    FROM stg_works s
    LEFT JOIN doctors d
      ON d.external_id = s.doctor_external_id
    WHERE s.external_id IS NOT NULL
      AND s.doctor_external_id IS NOT NULL
      AND d.doctor_id IS NULL
    LIMIT 20;
  `,

  /* ============================
     [SPLIT] RE-VINCULAR REFERENCIAS
     - si un work entro antes que su doctor (doctor_id quedo NULL), cuando el
       doctor ya existe se completa doctor_id. Igual para clinic_id.
     ============================ */
  relinkWorksDoctors: `
    UPDATE works w
    JOIN doctors d
      ON d.external_id = w.doctor_external_id
    SET w.doctor_id = d.doctor_id,
        w.updated_at = NOW(),
        w.updated_by = 'etl'
    WHERE w.doctor_id IS NULL
      AND w.doctor_external_id IS NOT NULL
      AND w.is_deleted = 0;
  `,

  relinkWorksClinics: `
    UPDATE works w
    JOIN clients c
      ON c.external_id = w.clinic_external_id
    SET w.clinic_id = c.client_id,
        w.updated_at = NOW(),
        w.updated_by = 'etl'
    WHERE w.clinic_id IS NULL
      AND w.clinic_external_id IS NOT NULL
      AND w.is_deleted = 0;
  `,

};
