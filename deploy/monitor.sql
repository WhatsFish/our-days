-- Run using a dedicated read-only status role; returns no private content.
SELECT
  (SELECT max(version) FROM schema_version) AS schema_version,
  (SELECT last_tick FROM worker_state WHERE id=true) AS last_tick,
  (SELECT error_code FROM worker_state WHERE id=true) AS worker_error,
  (SELECT paused FROM settings WHERE id=true) AS paused,
  (SELECT count(*) FROM imports WHERE status IN ('queued','processing')
     AND created_at < now()-interval '10 minutes') AS stuck_imports,
  (SELECT count(*) FROM editions, settings
     WHERE status='scheduled' AND NOT paused
       AND send_at < now()-interval '15 minutes') AS missed_editions,
  (SELECT count(*) FROM editions,settings WHERE status='scheduled'
     AND day BETWEEN (now() AT TIME ZONE timezone)::date + 1
     AND (now() AT TIME ZONE timezone)::date + 7) AS next_week_count,
  (SELECT count(*) FROM deliveries d JOIN editions e ON e.id=d.edition_id
     WHERE d.status IN ('failed','unknown','pending','sending')
     OR (d.status='accepted' AND e.published_at<now()-interval '15 minutes')) AS delivery_attention;
