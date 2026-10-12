export type DoctorsResponse = { items: DoctorItem[]; has_more?: boolean };

export type DoctorItem = {
  id: number;
  name?: string | null;
  surname?: string | null;
  nif?: string | null;
  collegiate_member?: string | null;
  address?: string | null;
  address2?: string | null;
  town?: string | null;
  province?: string | null;
  cp?: string | null;
  country?: string | null;
  country_name?: string | null;
  email?: string | null;
  phone?: string | null;
  alternate_phone?: string | null;
  mobile_phone?: string | null;
  fax?: string | null;
  clinics?: Array<{ id: number; code?: string; name?: string }>;
};
