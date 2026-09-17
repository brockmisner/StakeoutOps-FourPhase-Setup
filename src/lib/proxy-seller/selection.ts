import type {
  ProxyRecommendation,
  ProxySellerGeoCountry,
} from "./types";

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

export function proxyTargetInventory(options: {
  catalog: ProxySellerGeoCountry[];
  country: string;
  region: string;
  city: string;
}): {
  country: string;
  region: string;
  city: string;
  isps: string[];
} {
  const country = options.catalog.find(
    (item) => normalized(item.code) === normalized(options.country),
  );
  if (!country) throw new Error(`Proxy-Seller does not list country ${options.country}`);
  const region = country.regions.find(
    (item) => normalized(item.name) === normalized(options.region),
  );
  if (!region) {
    throw new Error(
      `Proxy-Seller does not list ${options.region} in ${country.code}`,
    );
  }
  const city = region.cities.find(
    (item) => normalized(item.name) === normalized(options.city),
  );
  if (!city) {
    throw new Error(
      `No exact Proxy-Seller city match for ${options.city}, ${region.name}; review required`,
    );
  }
  const isps = [...new Set(city.isps.map((isp) => isp.trim()).filter(Boolean))];
  if (isps.length === 0) {
    throw new Error(`Proxy-Seller lists no ISP for ${city.name}, ${region.name}`);
  }

  return {
    country: country.code,
    region: region.name,
    city: city.name,
    isps,
  };
}

export function recommendProxyTarget(options: {
  catalog: ProxySellerGeoCountry[];
  country: string;
  region: string;
  city: string;
  usedIsps?: string[];
  preferredIsp?: string;
}): ProxyRecommendation {
  const target = proxyTargetInventory(options);
  const isps = target.isps;

  const counts = new Map<string, number>();
  for (const isp of options.usedIsps ?? []) {
    const key = normalized(isp);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const preferred = options.preferredIsp
    ? isps.find((isp) => normalized(isp) === normalized(options.preferredIsp!))
    : undefined;
  const selected = preferred ?? isps.toSorted((left, right) => {
    const byUse = (counts.get(normalized(left)) ?? 0) - (counts.get(normalized(right)) ?? 0);
    return byUse || left.localeCompare(right);
  })[0];

  return {
    country: target.country,
    region: target.region,
    city: target.city,
    isp: selected,
    diversityStatus: counts.has(normalized(selected)) ? "reused" : "unique",
    availableIspCount: isps.length,
  };
}

export function proxyGatewayForCountry(countryCode: string): string {
  const code = countryCode.toUpperCase();
  if (["US", "CA", "MX"].includes(code)) return "us.res.proxy-seller.com";
  if (["JP", "KR", "SG", "PH", "TH", "VN", "MY", "ID", "AU", "NZ"].includes(code)) {
    return "asia.res.proxy-seller.com";
  }
  return "res.proxy-seller.com";
}
