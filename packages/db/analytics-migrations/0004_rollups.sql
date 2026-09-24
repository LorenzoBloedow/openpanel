-- Rollups maintained by the ingest consumer in the same transaction as the
-- events (they replace ClickHouse materialized views).

-- dau_mv: who was active on each UTC day, anonymous devices included.
CREATE TABLE analytics.dau (
  project_id text NOT NULL,
  day date NOT NULL,
  profile_id text NOT NULL,
  PRIMARY KEY (project_id, day, profile_id)
);

-- cohort_events_mv: which identified profiles (profile_id <> device_id)
-- fired which event on each UTC day. Feeds the retention fast path.
CREATE TABLE analytics.profile_event_days (
  project_id text NOT NULL,
  name text NOT NULL,
  day date NOT NULL,
  profile_id text NOT NULL,
  PRIMARY KEY (project_id, name, day, profile_id)
);

-- distinct_event_names_mv: every event name a project has sent.
CREATE TABLE analytics.event_names (
  project_id text NOT NULL,
  name text NOT NULL,
  event_count bigint NOT NULL DEFAULT 0,
  first_seen_at timestamptz(3) NOT NULL,
  last_seen_at timestamptz(3) NOT NULL,
  PRIMARY KEY (project_id, name)
);

-- The key half of event_property_values_mv: which property keys each event
-- name carries. Values are read on demand from recent events instead.
CREATE TABLE analytics.event_property_keys (
  project_id text NOT NULL,
  name text NOT NULL,
  property_key text NOT NULL,
  last_seen_at timestamptz(3) NOT NULL,
  PRIMARY KEY (project_id, name, property_key)
);
