-- Sizing query for scripts/sql/rails-progress-export.sql. READ ONLY.
--
--   psql -X "$RAILS_READONLY_DATABASE_URL" -v active_since='2024-11-18' \
--     -f scripts/sql/rails-progress-export-counts.sql
--
-- Prints aggregate counts only, with no emails or ids, so the output is safe to
-- paste into a report.
--
-- Takes the export's parameters (active_window, active_since, after_user_id,
-- through_user_id) and repeats its CTEs, so for the same parameters:
--   exported_users          = lines in the export
--   lesson_completion_rows  = lesson entries across those lines
--   series_completion_rows  = series entries across those lines
-- Pass the same active_since as the export so both use one cutoff. Keep the
-- CTEs below in step with the export; the importer's end-to-end test runs both
-- files and compares them.

\set QUIET on
\set ON_ERROR_STOP on

\if :{?active_window}
\else
  \set active_window '24 months'
\endif

\if :{?after_user_id}
\else
  \set after_user_id 0
\endif

\if :{?through_user_id}
\else
  \set through_user_id 2147483647
\endif

\if :{?active_since}
\else
  \set active_since ''
\endif

\pset format unaligned
\pset tuples_only on
\pset pager off

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

WITH cutoff AS (
  SELECT COALESCE(
    NULLIF(:'active_since', '')::timestamp,
    (now() AT TIME ZONE 'UTC') - :'active_window'::interval
  ) AS at
),
recent_view_users AS (
  SELECT lv.user_id
  FROM lesson_views lv, cutoff
  WHERE lv.user_id IS NOT NULL
    AND lv.user_id > :after_user_id
    AND lv.user_id <= :through_user_id
    AND COALESCE(lv.updated_at, lv.created_at) >= cutoff.at
  GROUP BY lv.user_id
),
recent_series_users AS (
  SELECT sp.user_id
  FROM series_progresses sp, cutoff
  WHERE sp.user_id IS NOT NULL
    AND sp.user_id > :after_user_id
    AND sp.user_id <= :through_user_id
    AND GREATEST(sp.updated_at, sp.last_lesson_watched_at) >= cutoff.at
  GROUP BY sp.user_id
),
active_users AS (
  SELECT u.id
  FROM users u
  CROSS JOIN cutoff
  LEFT JOIN recent_view_users rv ON rv.user_id = u.id
  LEFT JOIN recent_series_users rs ON rs.user_id = u.id
  WHERE u.id > :after_user_id
    AND u.id <= :through_user_id
    AND (
      rv.user_id IS NOT NULL
      OR rs.user_id IS NOT NULL
      OR u.current_sign_in_at >= cutoff.at
      OR u.last_sign_in_at >= cutoff.at
    )
),
completed_lessons AS (
  SELECT lv.user_id, l.id AS lesson_id
  FROM lesson_views lv
  JOIN active_users au ON au.id = lv.user_id
  JOIN lessons l
    ON l.id = lv.lesson_id
   AND lv.lesson_version_id = l.current_lesson_version_id
  WHERE lv.did_complete
  GROUP BY lv.user_id, l.id, l.slug
),
completed_series AS (
  SELECT
    sp.user_id,
    CASE WHEN sp.progressable_type = 'Playlist' THEN sp.progressable_id END AS playlist_id,
    CASE
      WHEN sp.progressable_type = 'Playlist' THEN NULL
      ELSE COALESCE(
        sp.series_id,
        CASE WHEN sp.progressable_type = 'Series' THEN sp.progressable_id END
      )
    END AS series_id
  FROM series_progresses sp
  JOIN active_users au ON au.id = sp.user_id
  WHERE sp.is_complete
    AND COALESCE(sp.site, 'egghead.io') = 'egghead.io'
  GROUP BY 1, 2, 3
),
exported_series AS (
  SELECT * FROM completed_series
  WHERE playlist_id IS NOT NULL OR series_id IS NOT NULL
),
exported_users AS (
  SELECT user_id FROM completed_lessons
  UNION
  SELECT user_id FROM exported_series
)
SELECT json_build_object(
  'active_window', :'active_window',
  'active_since', NULLIF(:'active_since', ''),
  'cutoff', to_char((SELECT at FROM cutoff), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'active_users', (SELECT count(*) FROM active_users),
  'exported_users', (SELECT count(*) FROM exported_users),
  'active_users_with_lesson_completions', (SELECT count(DISTINCT user_id) FROM completed_lessons),
  'lesson_completion_rows', (SELECT count(*) FROM completed_lessons),
  'distinct_lessons', (SELECT count(DISTINCT lesson_id) FROM completed_lessons),
  'series_completion_rows', (SELECT count(*) FROM exported_series),
  'playlist_completion_rows', (SELECT count(*) FROM exported_series WHERE playlist_id IS NOT NULL)
)::text;

ROLLBACK;
