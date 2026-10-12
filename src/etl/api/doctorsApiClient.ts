import { http } from "../common/http.js";
import { ApiPage, toApiPage } from "../common/pagination.js";
import { DoctorItem, DoctorsResponse } from "../../types/doctorsApi.js";

// Pagina + has_more (para que el ETL detecte solo cuantas paginas hay)
export async function fetchDoctorsPageWithMeta(page: number): Promise<ApiPage<DoctorItem>> {
  const { data } = await http.get<DoctorsResponse>("/doctors", { params: { page } });
  return toApiPage<DoctorItem>(data);
}

export async function fetchDoctorsPage(page: number) {
  return (await fetchDoctorsPageWithMeta(page)).items;
}
