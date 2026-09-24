-- Computed cohort membership. A recompute replaces a cohort's rows.
CREATE TABLE analytics.cohort_members (
  project_id text NOT NULL,
  cohort_id text NOT NULL,
  profile_id text NOT NULL,
  matched_at timestamptz(3) NOT NULL DEFAULT now(),
  matching_properties jsonb NOT NULL DEFAULT '{}',
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (project_id, cohort_id, profile_id)
);

CREATE INDEX cohort_members_profile_idx
  ON analytics.cohort_members (project_id, profile_id);

CREATE TABLE analytics.cohort_metadata (
  project_id text NOT NULL,
  cohort_id text NOT NULL,
  member_count bigint NOT NULL DEFAULT 0,
  last_computed_at timestamptz(3) NOT NULL DEFAULT now(),
  sample_profiles text[] NOT NULL DEFAULT '{}',
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (project_id, cohort_id)
);

-- Google Search Console daily metrics; a re-sync overwrites a day.
CREATE TABLE analytics.gsc_daily (
  project_id text NOT NULL,
  date date NOT NULL,
  clicks integer NOT NULL DEFAULT 0,
  impressions integer NOT NULL DEFAULT 0,
  ctr real NOT NULL DEFAULT 0,
  position real NOT NULL DEFAULT 0,
  synced_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, date)
);

CREATE TABLE analytics.gsc_pages_daily (
  project_id text NOT NULL,
  date date NOT NULL,
  page text NOT NULL,
  clicks integer NOT NULL DEFAULT 0,
  impressions integer NOT NULL DEFAULT 0,
  ctr real NOT NULL DEFAULT 0,
  position real NOT NULL DEFAULT 0,
  synced_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, date, page)
);

CREATE TABLE analytics.gsc_queries_daily (
  project_id text NOT NULL,
  date date NOT NULL,
  query text NOT NULL,
  clicks integer NOT NULL DEFAULT 0,
  impressions integer NOT NULL DEFAULT 0,
  ctr real NOT NULL DEFAULT 0,
  position real NOT NULL DEFAULT 0,
  synced_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, date, query)
);
