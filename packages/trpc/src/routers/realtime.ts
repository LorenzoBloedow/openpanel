import {
  convertClickhouseDateToJs,
  getProfiles,
  type IClickhouseEvent,
  transformEvent,
} from '@openpanel/db';
import { anQuery } from '@openpanel/db/src/analytics/client';
import { type Sql, raw, sql } from '@openpanel/db/src/analytics/sql';
import { z } from 'zod';
import { createdSince, liveWindowStart } from '../analytics-time';
import { createTRPCRouter, protectedProcedure } from '../trpc';

const realtimeLocationSchema = z.object({
  country: z.string().optional(),
  city: z.string().optional(),
  lat: z.number().optional(),
  long: z.number().optional(),
});

type RealtimeLocation = z.infer<typeof realtimeLocationSchema>;

const realtimeBadgeDetailScopeSchema = z.enum([
  'country',
  'city',
  'coordinate',
  'merged',
]);

/** Events of the last 30 minutes. */
const inRealtimeWindow = (): Sql => createdSince(liveWindowStart());

/**
 * ClickHouse's `toDecimal64(<literal>, 4)` scaled by 10^4: the literal is a
 * Float64, multiplied by 10^4 in double precision and truncated toward zero.
 */
function literalDecimal4(value: number): number {
  return Math.trunc(Number(value.toFixed(4)) * 10_000);
}

/**
 * `toDecimal64(<Float32 column>, 4)` scaled by 10^4: ClickHouse multiplies a
 * Float32 in single precision before truncating, so a stored 77.5946
 * (77.594597f) reads as 77.5945 and no longer matches the 77.5946 the map
 * sends. Postgres' real * real is single precision too.
 */
function columnDecimal4(column: Sql): Sql {
  return sql`trunc((${column} * 10000::real)::double precision)`;
}

function buildRealtimeLocationFilter(locations: RealtimeLocation[]): Sql {
  const points = locations.filter(
    (
      location
    ): location is RealtimeLocation & {
      lat: number;
      long: number;
    } => typeof location.lat === 'number' && typeof location.long === 'number'
  );

  if (points.length === 0) {
    return buildRealtimeCityFilter(locations);
  }

  return sql`(country, city, ${columnDecimal4(raw('longitude'))}, ${columnDecimal4(raw('latitude'))}) IN (
    SELECT * FROM unnest(
      ${points.map((point) => point.country ?? '')}::text[],
      ${points.map((point) => point.city ?? '')}::text[],
      ${points.map((point) => literalDecimal4(point.long))}::double precision[],
      ${points.map((point) => literalDecimal4(point.lat))}::double precision[]
    )
  )`;
}

function buildRealtimeCountryFilter(locations: RealtimeLocation[]): Sql {
  const countries = [
    ...new Set(locations.map((location) => location.country ?? '')),
  ];

  return sql`country = ANY(${countries}::text[])`;
}

function buildRealtimeCityFilter(locations: RealtimeLocation[]): Sql {
  if (locations.length === 0) {
    return buildRealtimeCountryFilter(locations);
  }

  return sql`(country, city) IN (
    SELECT * FROM unnest(
      ${locations.map((location) => location.country ?? '')}::text[],
      ${locations.map((location) => location.city ?? '')}::text[]
    )
  )`;
}

function buildRealtimeBadgeDetailsFilter(input: {
  detailScope: z.infer<typeof realtimeBadgeDetailScopeSchema>;
  locations: RealtimeLocation[];
}): Sql {
  if (input.detailScope === 'country') {
    return buildRealtimeCountryFilter(input.locations);
  }

  if (input.detailScope === 'city') {
    return buildRealtimeCityFilter(input.locations);
  }

  if (input.detailScope === 'merged') {
    return buildRealtimeCityFilter(input.locations);
  }

  return buildRealtimeLocationFilter(input.locations);
}

/**
 * `round(avg(duration) / 1000, 2)`: a Float64 average in seconds, rounded
 * the way ClickHouse rounds floats (nearbyint of the scaled value, ties to
 * even — Postgres' round(float8)).
 */
const AVG_DURATION_SECONDS = sql`round(avg(duration::double precision) / 1000 * 100) / 100`;

interface CoordinatePoint {
  country: string;
  city: string;
  long: number;
  lat: number;
  count: number;
};

function mergeByRadius(
  points: CoordinatePoint[],
  radius: number
): CoordinatePoint[] {
  // Highest-count points become cluster centers; nearby points get absorbed into them
  const sorted = [...points].sort((a, b) => b.count - a.count);
  const absorbed = new Uint8Array(sorted.length);
  const clusters: CoordinatePoint[] = [];

  for (let i = 0; i < sorted.length; i++) {
    if (absorbed[i]) {
      continue;
    }
    const seed = sorted[i];
    if (!seed) {
      continue;
    }
    const center: CoordinatePoint = { ...seed };
    for (let j = i + 1; j < sorted.length; j++) {
      if (absorbed[j]) {
        continue;
      }
      const other = sorted[j];
      if (!other) {
        continue;
      }
      const dlat = other.lat - center.lat;
      const dlong = other.long - center.long;
      if (Math.sqrt(dlat * dlat + dlong * dlong) <= radius) {
        center.count += other.count;
        absorbed[j] = 1;
      }
    }
    clusters.push(center);
  }

  return clusters;
}

function adaptiveCluster(
  points: CoordinatePoint[],
  target: number
): CoordinatePoint[] {
  if (points.length <= target) {
    return points;
  }

  // Expand merge radius until we hit the target (~55km → ~111km → ~333km → ~1110km)
  for (const radius of [0.5, 1, 3, 10]) {
    const clustered = mergeByRadius(points, radius);
    if (clustered.length <= target) {
      return clustered;
    }
  }

  return points.slice(0, target);
}

export const realtimeRouter = createTRPCRouter({
  coordinates: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input }) => {
      const res = await anQuery<CoordinatePoint>(sql`
        SELECT
          country,
          city,
          longitude AS long,
          latitude AS lat,
          COUNT(DISTINCT session_id) AS count
        FROM analytics.events
        WHERE project_id = ${input.projectId}
          AND ${inRealtimeWindow()}
          AND longitude IS NOT NULL
          AND latitude IS NOT NULL
        GROUP BY country, city, longitude, latitude
        ORDER BY count DESC
        LIMIT 5000
      `);

      return adaptiveCluster(res, 500);
    }),
  mapBadgeDetails: protectedProcedure
    .input(
      z.object({
        detailScope: realtimeBadgeDetailScopeSchema,
        projectId: z.string(),
        locations: z.array(realtimeLocationSchema).min(1).max(200),
      })
    )
    .query(async ({ input }) => {
      const matching = sql`project_id = ${input.projectId}
        AND ${inRealtimeWindow()}
        AND ${buildRealtimeBadgeDetailsFilter(input)}`;

      const [summary, topReferrers, topPaths, topEvents, recentSessions] =
        await Promise.all([
          anQuery<{
            total_sessions: number;
            total_profiles: number;
          }>(sql`
            SELECT
              COUNT(DISTINCT session_id) AS total_sessions,
              COUNT(DISTINCT NULLIF(profile_id, '')) AS total_profiles
            FROM analytics.events
            WHERE ${matching}
          `),
          anQuery<{
            referrer_name: string;
            count: number;
          }>(sql`
            SELECT referrer_name, COUNT(DISTINCT session_id) AS count
            FROM analytics.events
            WHERE ${matching}
              AND referrer_name <> ''
            GROUP BY referrer_name
            ORDER BY count DESC
            LIMIT 3
          `),
          anQuery<{
            origin: string;
            path: string;
            count: number;
          }>(sql`
            SELECT origin, path, COUNT(DISTINCT session_id) AS count
            FROM analytics.events
            WHERE ${matching}
              AND path <> ''
            GROUP BY origin, path
            ORDER BY count DESC
            LIMIT 3
          `),
          anQuery<{
            name: string;
            count: number;
          }>(sql`
            SELECT name, COUNT(DISTINCT session_id) AS count
            FROM analytics.events
            WHERE ${matching}
              AND name NOT IN ('screen_view', 'session_start', 'session_end')
            GROUP BY name
            ORDER BY count DESC
            LIMIT 3
          `),
          anQuery<{
            profile_id: string;
            session_id: string;
            created_at: string;
            path: string;
            name: string;
            country: string;
            city: string;
          }>(sql`
            SELECT
              session_id,
              profile_id,
              created_at,
              path,
              name,
              country,
              city
            FROM (
              SELECT
                session_id,
                profile_id,
                created_at,
                path,
                name,
                country,
                city,
                row_number() OVER (
                  PARTITION BY session_id ORDER BY created_at DESC
                ) AS rn
              FROM analytics.events
              WHERE ${matching}
            ) AS latest_event_per_session
            WHERE rn = 1
            ORDER BY created_at DESC
            LIMIT 8
          `),
        ]);

      const profiles = await getProfiles(
        recentSessions.map((item) => item.profile_id).filter(Boolean),
        input.projectId
      );
      const profileMap = new Map(
        profiles.map((profile) => [profile.id, profile])
      );

      return {
        summary: {
          totalSessions: summary[0]?.total_sessions ?? 0,
          totalProfiles: summary[0]?.total_profiles ?? 0,
          totalLocations: input.locations.length,
          totalCountries: new Set(
            input.locations.map((location) => location.country).filter(Boolean)
          ).size,
          totalCities: new Set(
            input.locations.map((location) => location.city).filter(Boolean)
          ).size,
        },
        topReferrers: topReferrers.map((item) => ({
          referrerName: item.referrer_name,
          count: item.count,
        })),
        topPaths,
        topEvents,
        recentProfiles: recentSessions.map((item) => {
          const profile = profileMap.get(item.profile_id);

          return {
            id: item.profile_id || item.session_id,
            profileId:
              item.profile_id && item.profile_id !== ''
                ? item.profile_id
                : null,
            sessionId: item.session_id,
            createdAt: convertClickhouseDateToJs(item.created_at),
            latestPath: item.path,
            latestEvent: item.name,
            city: profile?.properties.city || item.city,
            country: profile?.properties.country || item.country,
            firstName: profile?.firstName ?? '',
            lastName: profile?.lastName ?? '',
            email: profile?.email ?? '',
            avatar: profile?.avatar ?? '',
          };
        }),
      };
    }),
  activeSessions: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input }) => {
      const rows = await anQuery<IClickhouseEvent>(sql`
        SELECT
          name, session_id, created_at, path, origin, referrer, referrer_name,
          country, city, region, os, os_version, browser, browser_version,
          device
        FROM analytics.events
        WHERE project_id = ${input.projectId}
          AND ${inRealtimeWindow()}
        ORDER BY created_at DESC
        LIMIT 50
      `);
      return rows.map(transformEvent);
    }),
  paths: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input }) => {
      const res = await anQuery<{
        origin: string;
        path: string;
        count: number;
        avg_duration: number;
        unique_sessions: number;
      }>(sql`
        SELECT
          origin,
          path,
          COUNT(*) AS count,
          COUNT(DISTINCT session_id) AS unique_sessions,
          ${AVG_DURATION_SECONDS} AS avg_duration
        FROM analytics.events
        WHERE project_id = ${input.projectId}
          AND path <> ''
          AND ${inRealtimeWindow()}
        GROUP BY path, origin
        ORDER BY count DESC
        LIMIT 50
      `);

      return res;
    }),
  referrals: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input }) => {
      const res = await anQuery<{
        referrer_name: string;
        count: number;
        avg_duration: number;
        unique_sessions: number;
      }>(sql`
        SELECT
          referrer_name,
          COUNT(*) AS count,
          COUNT(DISTINCT session_id) AS unique_sessions,
          ${AVG_DURATION_SECONDS} AS avg_duration
        FROM analytics.events
        WHERE project_id = ${input.projectId}
          AND ${inRealtimeWindow()}
        GROUP BY referrer_name
        ORDER BY count DESC
        LIMIT 50
      `);

      return res;
    }),
  geo: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input }) => {
      const res = await anQuery<{
        country: string;
        city: string;
        count: number;
        avg_duration: number;
        unique_sessions: number;
      }>(sql`
        SELECT
          country,
          city,
          COUNT(*) AS count,
          COUNT(DISTINCT session_id) AS unique_sessions,
          ${AVG_DURATION_SECONDS} AS avg_duration
        FROM analytics.events
        WHERE project_id = ${input.projectId}
          AND ${inRealtimeWindow()}
        GROUP BY country, city
        ORDER BY count DESC
        LIMIT 50
      `);

      return res;
    }),
});
