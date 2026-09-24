-- The analytics schema: everything that lived in ClickHouse, plus the
-- operational state that lived in Redis. Prisma manages `public`; these
-- files are applied by src/analytics/migrate.ts (pnpm migrate:deploy).
CREATE SCHEMA IF NOT EXISTS analytics;

-- ClickHouse's toFloat64OrNull for the text values in the flattened
-- `properties` maps (numeric filters, sums over numeric properties).
-- pg_input_is_valid needs Postgres 16+.
CREATE OR REPLACE FUNCTION analytics.to_float_or_null(value text)
RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN value IS NOT NULL AND pg_input_is_valid(value, 'double precision')
      THEN value::double precision
  END
$$;

-- ClickHouse's parseDateTimeBestEffortOrNull. Stable, not immutable: text
-- without an offset is read in the session time zone, like the original.
CREATE OR REPLACE FUNCTION analytics.to_ts_or_null(value text)
RETURNS timestamptz
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN value IS NOT NULL AND value <> '' AND pg_input_is_valid(value, 'timestamptz')
      THEN value::timestamptz
  END
$$;
