import { http } from "../common/http.js";
import { ApiPage, toApiPage } from "../common/pagination.js";
import { ClinicItem, ClinicsResponse } from "../../types/clinicsApi.js";

// Pagina + has_more (para que el ETL detecte solo cuantas paginas hay)
export async function fetchClinicsPageWithMeta(page: number): Promise<ApiPage<ClinicItem>> {
  const { data } = await http.get<ClinicsResponse>("/clinics", { params: { page } });
  return toApiPage<ClinicItem>(data);
}
