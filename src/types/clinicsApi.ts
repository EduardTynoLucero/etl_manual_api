export type ClinicsResponse = { items: ClinicItem[]; has_more?: boolean };

export type ClinicItem = {
  id: number;
  code?: string | null;
  name?: string | null;
  address?: string | null;
  address2?: string | null;
  town?: string | null;
  province?: string | null;
  cp?: string | null;
  email?: string | null;
  phone?: string | null;
  alternate_phone?: string | null;
  mobile_phone?: string | null;
  fax?: string | null;
  web_page?: string | null;
  fiscal_name?: string | null;
  fiscal_address?: string | null;
  fiscal_address2?: string | null;
  fiscal_town?: string | null;
  fiscal_province?: string | null;
  fiscal_cp?: string | null;
  fiscal_number?: string | null;
  iban?: string | null;
  entry_date?: string | null;
};
