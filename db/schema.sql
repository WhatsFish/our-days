BEGIN;
CREATE TABLE IF NOT EXISTS schema_version (version integer PRIMARY KEY);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  role text NOT NULL CHECK (role IN ('admin','reader')),
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS login_limits (
  bucket text PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS photos (
  id uuid PRIMARY KEY,
  sha256 text NOT NULL UNIQUE,
  original_ext text NOT NULL,
  original_bytes bigint NOT NULL,
  captured_raw text,
  latitude double precision,
  longitude double precision,
  date_label text NOT NULL DEFAULT '',
  place_label text NOT NULL DEFAULT '',
  facts text NOT NULL DEFAULT '',
  caption text NOT NULL DEFAULT '',
  approved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS imports (
  id uuid PRIMARY KEY,
  ext text NOT NULL CHECK (ext IN ('zip','image')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','done','failed')),
  added integer NOT NULL DEFAULT 0,
  duplicates integer NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
ALTER TABLE photos ADD COLUMN IF NOT EXISTS metadata_place text NOT NULL DEFAULT '';
ALTER TABLE photos ADD COLUMN IF NOT EXISTS gps_place_guess text NOT NULL DEFAULT '';
ALTER TABLE photos ADD COLUMN IF NOT EXISTS geocoded_at timestamptz;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS queue_pinned_at timestamptz;
CREATE TABLE IF NOT EXISTS settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  send_time text NOT NULL DEFAULT '08:00',
  paused boolean NOT NULL DEFAULT true,
  weather_lat double precision,
  weather_lon double precision,
  weather_city text NOT NULL DEFAULT '',
  almanac boolean NOT NULL DEFAULT false,
  star_note text NOT NULL DEFAULT ''
);
INSERT INTO settings(id) VALUES (true) ON CONFLICT DO NOTHING;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS enabled_at timestamptz;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS queue_loop boolean NOT NULL DEFAULT false;
ALTER TABLE settings ALTER COLUMN almanac SET DEFAULT false;
CREATE TABLE IF NOT EXISTS editions (
  id uuid PRIMARY KEY,
  day date NOT NULL UNIQUE,
  photo_id uuid NOT NULL REFERENCES photos(id),
  title text NOT NULL,
  send_at timestamptz NOT NULL,
  notify boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','published','cancelled')),
  snapshot jsonb,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status='published') = (snapshot IS NOT NULL AND published_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS deliveries (
  id uuid PRIMARY KEY,
  edition_id uuid NOT NULL UNIQUE REFERENCES editions(id),
  channel text NOT NULL CHECK (channel IN ('wechat-test','pushplus','wecom')),
  status text NOT NULL CHECK (status IN ('pending','sending','accepted','delivered','failed','unknown','disabled')),
  record_id text,
  error_code text,
  attempts integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS favorites (
  edition_id uuid PRIMARY KEY REFERENCES editions(id)
);
ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_channel_check;
ALTER TABLE deliveries ADD CONSTRAINT deliveries_channel_check CHECK (channel IN ('wechat-test','pushplus','wecom'));
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS recipient_results jsonb;
CREATE TABLE IF NOT EXISTS wechat_receipts (
  record_id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('delivered','failed')),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS wechat_mass_receipts (
  record_id text PRIMARY KEY,
  status text NOT NULL,
  total_count integer NOT NULL CHECK (total_count >= 0),
  filter_count integer NOT NULL CHECK (filter_count >= 0),
  sent_count integer NOT NULL CHECK (sent_count >= 0),
  error_count integer NOT NULL CHECK (error_count >= 0),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS worker_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_tick timestamptz,
  error_code text
);
CREATE TABLE IF NOT EXISTS ai_events (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  model text NOT NULL,
  input_tokens integer,
  output_tokens integer,
  cost_usd numeric,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS editions_due ON editions(send_at) WHERE status='scheduled';
ALTER TABLE ai_events ADD COLUMN IF NOT EXISTS task text NOT NULL DEFAULT 'caption';
ALTER TABLE ai_events ADD COLUMN IF NOT EXISTS error_code text;
ALTER TABLE ai_events ADD COLUMN IF NOT EXISTS cost_cny numeric;
CREATE OR REPLACE VIEW photo_queue AS
SELECT p.id AS photo_id,
  (SELECT max(e.day) FROM editions e WHERE e.photo_id=p.id AND e.status='published') AS last_sent_day
FROM photos p CROSS JOIN settings s
WHERE s.id=true AND p.approved
  AND NOT EXISTS (
    SELECT 1 FROM editions e LEFT JOIN deliveries d ON d.edition_id=e.id
    WHERE e.photo_id=p.id AND
      (e.status='scheduled' OR (e.status='published' AND COALESCE(d.status,'pending') NOT IN ('accepted','delivered')))
  )
  AND (s.queue_loop OR NOT EXISTS (
    SELECT 1 FROM editions e WHERE e.photo_id=p.id AND e.status<>'cancelled'
  ));
CREATE INDEX IF NOT EXISTS imports_queued ON imports(created_at) WHERE status IN ('queued','processing');
CREATE OR REPLACE VIEW service_health AS
SELECT
  (SELECT max(version) FROM schema_version) AS schema_version,
  (SELECT last_tick FROM worker_state WHERE id=true) AS last_tick,
  (SELECT error_code FROM worker_state WHERE id=true) AS worker_error,
  (SELECT paused FROM settings WHERE id=true) AS paused,
  (SELECT count(*)::int FROM imports WHERE status IN ('queued','processing')
    AND created_at<now()-interval '10 minutes') AS stuck_imports,
  (SELECT count(*)::int FROM editions,settings WHERE status='scheduled' AND NOT paused
    AND send_at<now()-interval '15 minutes') AS missed_editions,
  (SELECT count(*)::int FROM photo_queue) AS next_week_count,
  (SELECT count(*)::int FROM deliveries d JOIN editions e ON e.id=d.edition_id
    WHERE d.status IN ('failed','unknown','pending','sending')
    OR (d.status='accepted' AND e.published_at<now()-interval '15 minutes')) AS delivery_attention,
  (SELECT queue_loop FROM settings WHERE id=true) AS queue_loop;
INSERT INTO schema_version(version) VALUES (1) ON CONFLICT DO NOTHING;
COMMIT;
