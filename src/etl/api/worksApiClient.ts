import { http } from "../common/http.js";
import { ApiPage, toApiPage } from "../common/pagination.js";
import { WorkItem, WorksResponse } from "../../types/worksApi.js";

// Listado: /works?updated_since=<dia 00:00>&page=N (igual que schedule_works_order_list_etl en UPDATED_SINCE)
export async function fetchWorksPageWithMeta(page: number, updatedSince: string): Promise<ApiPage<WorkItem>> {
  const { data } = await http.get<WorksResponse>("/works", { params: { updated_since: updatedSince, page } });
  return toApiPage<WorkItem>(data);
}

// Detalle (mantenimiento): /works/{id}
export async function fetchWorkDetail(id: number) {
  const { data } = await http.get<any>(`/works/${id}`);
  return (data?.item ?? data ?? null) as WorkItem | null;
}
