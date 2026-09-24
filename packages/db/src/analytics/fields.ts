/**
 * Field names of report filters, breakdowns and metrics — the part of the
 * former ClickHouse chart/filter helpers that has nothing to do with SQL,
 * with the same names and behaviour. The Postgres SQL built from these names
 * lives in ./filters.ts.
 */

/**
 * How a column's values compare: text columns bytewise, number columns
 * numerically, timestamps as instants (text input read in the project zone).
 */
export type ColumnKind = 'text' | 'number' | 'timestamp' | 'uuid' | 'boolean';

/**
 * Top-level columns of analytics.events (EVENT_TOP_LEVEL_COLUMNS in
 * chart.service.ts). `groups` and `properties` are not filterable columns.
 */
export const EVENT_TABLE_COLUMNS: Readonly<Record<string, ColumnKind>> = {
  id: 'uuid',
  name: 'text',
  sdk_name: 'text',
  sdk_version: 'text',
  device_id: 'text',
  profile_id: 'text',
  project_id: 'text',
  session_id: 'text',
  path: 'text',
  origin: 'text',
  referrer: 'text',
  referrer_name: 'text',
  referrer_type: 'text',
  duration: 'number',
  revenue: 'number',
  created_at: 'timestamp',
  country: 'text',
  city: 'text',
  region: 'text',
  longitude: 'number',
  latitude: 'number',
  os: 'text',
  os_version: 'text',
  browser: 'text',
  browser_version: 'text',
  device: 'text',
  brand: 'text',
  model: 'text',
  imported_at: 'timestamp',
};

/** Columns of analytics.sessions a filter or breakdown may name. */
export const SESSION_TABLE_COLUMNS: Readonly<Record<string, ColumnKind>> = {
  id: 'text',
  project_id: 'text',
  profile_id: 'text',
  device_id: 'text',
  created_at: 'timestamp',
  ended_at: 'timestamp',
  is_bounce: 'boolean',
  entry_origin: 'text',
  entry_path: 'text',
  exit_origin: 'text',
  exit_path: 'text',
  screen_view_count: 'number',
  revenue: 'number',
  event_count: 'number',
  duration: 'number',
  country: 'text',
  region: 'text',
  city: 'text',
  longitude: 'number',
  latitude: 'number',
  device: 'text',
  brand: 'text',
  model: 'text',
  browser: 'text',
  browser_version: 'text',
  os: 'text',
  os_version: 'text',
  utm_medium: 'text',
  utm_source: 'text',
  utm_campaign: 'text',
  utm_content: 'text',
  utm_term: 'text',
  referrer: 'text',
  referrer_name: 'text',
  referrer_type: 'text',
  version: 'number',
};

/**
 * Columns whose untyped gt/gte/lt/lte compare as Float64 on both sides
 * (`isNumericColumn` in chart.service.ts).
 */
export const NUMERIC_FILTER_COLUMNS: ReadonlySet<string> = new Set([
  'duration',
  'revenue',
  'longitude',
  'latitude',
]);

/**
 * camelCase names older clients and saved reports send, mapped to the
 * snake_case column.
 */
export const EVENT_FIELD_ALIASES: Readonly<Record<string, string>> = {
  referrerName: 'referrer_name',
  referrerType: 'referrer_type',
  sessionId: 'session_id',
  deviceId: 'device_id',
  profileId: 'profile_id',
  projectId: 'project_id',
  osVersion: 'os_version',
  browserVersion: 'browser_version',
  sdkName: 'sdk_name',
  sdkVersion: 'sdk_version',
  createdAt: 'created_at',
  importedAt: 'imported_at',
};

const EVENT_UTM_BARE_COLUMNS: ReadonlySet<string> = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
]);

/**
 * The canonical form of a field name: an alias becomes its column, a bare
 * `utm_*` becomes `properties.__query.utm_*` (on events the UTM values live
 * in the properties). Anything else is returned unchanged; guard with
 * {@link isKnownEventField} before using a name.
 */
export function normalizeEventField(name: string): string {
  if (Object.hasOwn(EVENT_FIELD_ALIASES, name)) {
    return EVENT_FIELD_ALIASES[name]!;
  }
  if (EVENT_UTM_BARE_COLUMNS.has(name)) {
    return `properties.__query.${name}`;
  }
  return name;
}

/** `cohort:<id>` → `<id>`. */
export function extractCohortId(breakdownName: string): string | null {
  if (breakdownName.startsWith('cohort:')) {
    return breakdownName.split(':')[1] ?? null;
  }
  return null;
}

/** The "all cohorts" breakdown (one label per cohort a profile is in). */
export function isAllCohortsBreakdown(breakdownName: string): boolean {
  return breakdownName === 'cohort';
}

/**
 * Whether a filter/breakdown name resolves to something the SQL builders
 * accept: an events column (or alias), a properties / profile / group path,
 * a cohort breakdown or `has_profile`. Unknown names are dropped by callers.
 */
export function isKnownEventField(name: string): boolean {
  if (name === 'has_profile') {
    return true;
  }
  if (isAllCohortsBreakdown(name) || extractCohortId(name)) {
    return true;
  }
  if (
    name.startsWith('properties.') ||
    name.startsWith('profile.') ||
    name.startsWith('group.')
  ) {
    return true;
  }
  const normalized = normalizeEventField(name);
  return (
    normalized.startsWith('properties.') ||
    Object.hasOwn(EVENT_TABLE_COLUMNS, normalized)
  );
}

/** Cohort ids of `cohort:<id>` breakdowns, de-duplicated. */
export function collectBreakdownCohortIds(
  breakdowns: readonly { name: string }[],
): string[] {
  const ids = new Set<string>();
  for (const breakdown of breakdowns) {
    const id = extractCohortId(breakdown.name);
    if (id) {
      ids.add(id);
    }
  }
  return [...ids];
}

// --- profiles and groups ---------------------------------------------------------

/**
 * Profiles columns a `profile.<field>` name may resolve to. Anything else is
 * not a column and never reaches SQL.
 */
export const PROFILE_TABLE_COLUMNS: ReadonlySet<string> = new Set([
  'id',
  'first_name',
  'last_name',
  'email',
  'avatar',
  'created_at',
  'last_seen_at',
]);

const PROFILE_COLUMN_KINDS: Readonly<Record<string, ColumnKind>> = {
  created_at: 'timestamp',
  last_seen_at: 'timestamp',
};

/** The comparison kind of a profiles column. */
export function profileColumnKind(column: string): ColumnKind {
  return PROFILE_COLUMN_KINDS[column] ?? 'text';
}

const PROFILE_PREFIX = /^profile\./;
const GROUP_PREFIX = /^group\./;
const PROPERTIES_PREFIX = /^properties\./;

/** Whether `name` (with or without the `profile.` prefix) is a profiles column. */
export function isProfileColumn(name: string): boolean {
  return PROFILE_TABLE_COLUMNS.has(name.replace(PROFILE_PREFIX, ''));
}

/**
 * The profiles columns a join must provide for the given `profile.*` names:
 * `properties` for `profile.properties.<key>`, the column for an allowlisted
 * field, and always `id`. Names outside the allowlist are dropped.
 */
export function profileJoinColumns(names: readonly string[]): string[] {
  const columns = new Set<string>(['id']);
  for (const name of names) {
    const field = name.replace(PROFILE_PREFIX, '');
    if (field.startsWith('properties.') || field === 'properties') {
      columns.add('properties');
    } else if (PROFILE_TABLE_COLUMNS.has(field)) {
      columns.add(field);
    }
  }
  return [...columns];
}

/**
 * What a `profile.<field>` name reads: a column, a properties key, or
 * nothing (`null`) when it is neither.
 */
export type ProfileField =
  | { column: string; kind: ColumnKind }
  | { propertyKey: string };

export function resolveProfileField(name: string): ProfileField | null {
  const field = name.replace(PROFILE_PREFIX, '');
  if (field.startsWith('properties.')) {
    return { propertyKey: field.replace(PROPERTIES_PREFIX, '') };
  }
  if (PROFILE_TABLE_COLUMNS.has(field)) {
    return { column: field, kind: profileColumnKind(field) };
  }
  return null;
}

/**
 * What a `group.<field>` name reads: `name` / `type` / `id`, a properties
 * key, or (anything else) the group id.
 */
export type GroupField =
  | { column: 'name' | 'type' | 'id' }
  | { propertyKey: string };

export function resolveGroupField(name: string): GroupField {
  const field = name.replace(GROUP_PREFIX, '');
  if (field === 'name' || field === 'type' || field === 'id') {
    return { column: field };
  }
  if (field.startsWith('properties.')) {
    return { propertyKey: field.replace(PROPERTIES_PREFIX, '') };
  }
  return { column: 'id' };
}

// --- wildcard property keys ------------------------------------------------------------

/**
 * The LIKE pattern a wildcard property name matches flattened keys with
 * (`transformPropertyKey` in chart.service.ts): `properties.items[*]` →
 * `items.%`, `properties.items.*.sku` → `items.%.sku`,
 * `properties.items[*].sku` → `items.%.sku`. Only a leading `properties.` is
 * stripped (`profile.properties.x.*` keeps its prefix and matches nothing —
 * as before), and a trailing `.*` is left literal.
 */
export function wildcardKeyPattern(property: string): string {
  return property
    .replace(PROPERTIES_PREFIX, '')
    .replace('.*.', '.%.')
    .replace(/\[\*\]$/, '.%')
    .replace(/\[\*\].?/, '.%.');
}

/** Whether a property name addresses several keys (see wildcardKeyPattern). */
export function isWildcardProperty(property: string): boolean {
  return property.includes('*');
}

// --- profile property narrowing ---------------------------------------------------------

const PROFILE_PROPERTY_PREFIX = 'profile.properties.';

/**
 * The `profile.properties.<key>` keys a query references, so a profile join
 * can select only those keys (see narrowedProfileSelect in ./filters.ts).
 * A wildcard reference needs the whole properties map.
 */
export function collectProfilePropertyKeys(refs: readonly { name: string }[]): {
  keys: string[];
  needsFullMap: boolean;
} {
  const keys = new Set<string>();
  let needsFullMap = false;
  for (const { name } of refs) {
    if (!name.startsWith(PROFILE_PROPERTY_PREFIX)) {
      continue;
    }
    if (isWildcardProperty(name)) {
      needsFullMap = true;
      continue;
    }
    keys.add(name.slice(PROFILE_PROPERTY_PREFIX.length));
  }
  return { keys: [...keys], needsFullMap };
}
