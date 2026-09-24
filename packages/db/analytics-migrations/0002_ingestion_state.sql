-- Operational state for ingestion that lived in Redis.

-- The active session of each device: replaces the Redis session blobs, the
-- profile → device index and the wall-clock sorted set the reaper scanned.
-- `session` is the full session snapshot (the shape of analytics.sessions);
-- the key columns are duplicated for lookups and the reaper.
CREATE TABLE analytics.live_sessions (
  project_id text NOT NULL,
  device_id text NOT NULL,
  session_id text NOT NULL,
  profile_id text NOT NULL DEFAULT '',
  -- Event time of the session's latest event (session.ended_at).
  ended_at timestamptz(3) NOT NULL,
  -- Wall-clock time of the last update; the reaper closes idle sessions.
  last_received_at timestamptz(3) NOT NULL DEFAULT now(),
  session jsonb NOT NULL,
  PRIMARY KEY (project_id, device_id)
);

CREATE INDEX live_sessions_profile_idx
  ON analytics.live_sessions (project_id, profile_id)
  WHERE profile_id <> '';

CREATE INDEX live_sessions_last_received_idx
  ON analytics.live_sessions (last_received_at);

-- /track duplicate suppression (a 100 ms window per request fingerprint).
-- UNLOGGED: no WAL, and losing it on a restart only reopens the window.
CREATE UNLOGGED TABLE analytics.request_dedupe (
  hash text PRIMARY KEY,
  expires_at timestamptz(3) NOT NULL
);

CREATE INDEX request_dedupe_expires_idx
  ON analytics.request_dedupe (expires_at);

-- Exactly-once application of queued records (event ids, profile operation
-- ids): the consumer inserts a batch's ids first, inside the same
-- transaction as the writes, and applies only the ids that were new. Rows
-- older than a week are pruned; queue redeliveries happen within minutes.
CREATE TABLE analytics.ingest_ledger (
  id uuid PRIMARY KEY,
  received_at timestamptz(3) NOT NULL DEFAULT now()
);

CREATE INDEX ingest_ledger_received_idx
  ON analytics.ingest_ledger (received_at);
