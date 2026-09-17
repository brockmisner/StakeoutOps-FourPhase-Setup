export type ProxySellerBusinessError = {
  message?: string;
  code?: number;
  customData?: unknown;
};

export type ProxySellerEnvelope<T> = {
  status?: "success" | "error" | string;
  data?: T | null;
  errors?: ProxySellerBusinessError[];
};

export type ProxySellerGeoCity = {
  name: string;
  isps: string[];
};

export type ProxySellerGeoRegion = {
  name: string;
  code?: number;
  cities: ProxySellerGeoCity[];
};

export type ProxySellerGeoCountry = {
  code: string;
  name: string;
  regions: ProxySellerGeoRegion[];
};

export type ProxySellerGeo = {
  country: string;
  region: string;
  city: string;
  isp: string;
};

export type ProxySellerList = {
  id: number;
  title: string;
  login: string;
  password: string;
  whitelist?: string;
  rotation: number | string;
  geo: ProxySellerGeo;
  export?: {
    ports?: number;
    ext?: string;
  };
};

export type ProxySellerPackage = {
  rotation?: number;
  traffic_limit?: string;
  expired_at?: string;
  is_link_date?: boolean;
  is_active?: boolean;
  package_key?: string;
  traffic_usage?: string;
  traffic_left?: string;
  traffic_usage_sub?: string;
  traffic_limit_sub?: string;
  traffic_left_sub?: string;
  tarif_id?: number;
  auto_renew?: boolean;
};

export type ProxySellerCreateListInput = {
  title: string;
  whitelist: string;
  geo: ProxySellerGeo;
  export: {
    ports: number;
    ext: string;
  };
  rotation: number;
};

export type ProxyRecommendation = ProxySellerGeo & {
  diversityStatus: "unique" | "reused";
  availableIspCount: number;
};
