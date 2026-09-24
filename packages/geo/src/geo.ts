import datacenterAsns from './datacenter-asns';

/**
 * Geolocation on Cloudflare comes from `request.cf`, which Cloudflare fills
 * in for the address that connected to the Worker. The MaxMind databases the
 * Node API read from disk (60–70 MB) can't be bundled into a Worker, so an
 * event is only geolocated when its IP is the connecting IP.
 *
 * Forwarded addresses (`openpanel-client-ip`, `x-client-ip`, the `__ip`
 * property, server-side SDKs, proxies such as the Next.js route handler)
 * get empty geo for now; see docs/cloudflare for the planned IP-range table.
 */

/** The subset of `IncomingRequestCfProperties` we read. */
export interface CfGeoProperties {
  country?: string | null;
  city?: string | null;
  region?: string | null;
  latitude?: string | number | null;
  longitude?: string | number | null;
  asn?: number | null;
  asOrganization?: string | null;
}

export interface GeoSource {
  /** `request.cf` of the incoming request. */
  cf?: CfGeoProperties | null;
  /** The address Cloudflare saw connect (`cf-connecting-ip`). */
  connectingIp?: string | null;
}

export interface GeoLocation {
  country: string | undefined;
  city: string | undefined;
  region: string | undefined;
  longitude: number | undefined;
  latitude: number | undefined;
}

const DEFAULT_GEO: GeoLocation = {
  country: undefined,
  city: undefined,
  region: undefined,
  longitude: undefined,
  latitude: undefined,
};

const ignore = ['127.0.0.1', '::1'];

// Cloudflare's pseudo country codes: XX = unknown, T1 = Tor.
const PSEUDO_COUNTRIES = new Set(['XX', 'T1']);

function normalizeIp(ip: string) {
  return ip.trim().toLowerCase();
}

/** `request.cf` describes the connecting address only. */
function cfFor(ip: string | undefined, source?: GeoSource) {
  if (!source?.cf || !ip || !source.connectingIp) {
    return null;
  }
  return normalizeIp(ip) === normalizeIp(source.connectingIp)
    ? source.cf
    : null;
}

function toNumber(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toText(value: string | null | undefined) {
  return value ? value : undefined;
}

export async function getGeoLocation(
  ip?: string,
  source?: GeoSource,
): Promise<GeoLocation> {
  if (!ip || ignore.includes(ip)) {
    return DEFAULT_GEO;
  }

  const cf = cfFor(ip, source);
  if (!cf) {
    return DEFAULT_GEO;
  }

  const country = toText(cf.country)?.toUpperCase();
  return {
    country: country && !PSEUDO_COUNTRIES.has(country) ? country : undefined,
    city: toText(cf.city),
    region: toText(cf.region),
    longitude: toNumber(cf.longitude),
    latitude: toNumber(cf.latitude),
  };
}

export interface AsnInfo {
  asn: number | undefined;
  org: string | undefined;
  // True when the ASN belongs to a datacenter / hosting provider (see
  // `datacenter-asns.ts`). Such traffic is unlikely to be a real end user.
  isHosting: boolean;
}

const DEFAULT_ASN: AsnInfo = {
  asn: undefined,
  org: undefined,
  isHosting: false,
};

const datacenterAsnSet = new Set<number>(datacenterAsns);

export function isDatacenterAsn(asn: number | undefined): boolean {
  return asn !== undefined && datacenterAsnSet.has(asn);
}

// Resolve the Autonomous System an IP belongs to and whether it is a known
// datacenter / hosting network. Used to flag (not block) likely-bot traffic.
export async function getAsnInfo(
  ip?: string,
  source?: GeoSource,
): Promise<AsnInfo> {
  if (!ip || ignore.includes(ip)) {
    return DEFAULT_ASN;
  }

  const cf = cfFor(ip, source);
  if (!cf) {
    return DEFAULT_ASN;
  }

  const asn = typeof cf.asn === 'number' ? cf.asn : undefined;
  return {
    asn,
    org: toText(cf.asOrganization),
    isHosting: isDatacenterAsn(asn),
  };
}
