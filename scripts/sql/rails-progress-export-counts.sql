-- Sizing query for scripts/sql/rails-progress-export.sql. READ ONLY.
--
--   psql "$RAILS_READONLY_DATABASE_URL" -v active_window='24 months' \
--     -f scripts/sql/rails-progress-export-counts.sql
--
-- Prints aggregate counts only, with no emails or ids, so the output is safe to
-- paste into a report. The activity and completion rules match the export file.

\set QUIET on
\set ON_ERROR_STOP on

\if :{?active_window}
\else
  \set active_window '24 months'
\endif

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

WITH cutoff AS (
  SELECT (now() AT TIME ZONE 'UTC') - :'active_window'::interval AS at
),
active_users AS (
  SELECT u.id
  FROM users u, cutoff
  WHERE u.current_sign_in_at >= cutoff.at
     OR u.last_sign_in_at >= cutoff.at
  UNION
  SELECT lv.user_id
  FROM lesson_views lv, cutoff
  WHERE lv.user_id IS NOT NULL
    AND COALESCE(lv.updated_at, lv.created_at) >= cutoff.at
  UNION
  SELECT sp.user_id
  FROM series_progresses sp, cutoff
  WHERE sp.user_id IS NOT NULL
    AND GREATEST(sp.updated_at, sp.last_lesson_watched_at) >= cutoff.at
),
completed_lessons AS (
  SELECT DISTINCT lv.user_id, lv.lesson_id
  FROM lesson_views lv
  JOIN active_users au ON au.id = lv.user_id
  JOIN lessons l
    ON l.id = lv.lesson_id
   AND lv.lesson_version_id = l.current_lesson_version_id
  WHERE lv.did_complete
),
completed_series AS (
  SELECT DISTINCT sp.user_id, sp.progressable_type, sp.progressable_id, sp.series_id
  FROM series_progresses sp
  JOIN active_users au ON au.id = sp.user_id
  WHERE sp.is_complete
    AND COALESCE(sp.site, 'egghead.io') = 'egghead.io'
)
SELECT
  :'active_window' AS active_window,
  (SELECT count(*) FROM active_users) AS active_users,
  (SELECT count(DISTINCT user_id) FROM completed_lessons) AS active_users_with_lesson_completions,
  (SELECT count(*) FROM completed_lessons) AS lesson_completion_rows,
  (SELECT count(DISTINCT lesson_id) FROM completed_lessons) AS distinct_lessons,
  (SELECT count(*) FROM completed_series) AS series_completion_rows,
  (SELECT count(*) FROM completed_series WHERE progressable_type = 'Playlist') AS playlist_completion_rows;

ROLLBACK;
