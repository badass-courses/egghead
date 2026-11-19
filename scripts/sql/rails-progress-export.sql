-- Rails (Postgres) → CourseBuilder progress export, active users only.
--
-- READ ONLY. Runs inside a READ ONLY transaction and writes nothing to Rails.
-- Prefer a read replica. On a primary, use the chunked form below.
--
--   psql -X "$RAILS_READONLY_DATABASE_URL" \
--     -v active_window='24 months' \
--     -f scripts/sql/rails-progress-export.sql \
--     -o rails-progress.jsonl
--
-- Parameters (psql -v):
--   active_window   Postgres interval. A user is active when they signed in, or
--                   touched a lesson view or series progress, within this window.
--                   Default '24 months'.
--   active_since    Fixed UTC cutoff timestamp. Overrides active_window.
--                   Default: unset.
--   after_user_id   Export only users with id > this value. Default 0.
--   through_user_id Export only users with id <= this value. Default: no bound.
--
-- Chunking: the single run holds one long REPEATABLE READ transaction over
-- lesson_views. To keep each transaction short, export id ranges and append
-- them in ascending order.
-- Each chunk filters lesson_views by user_id, which is indexed:
--
--   max=$(psql -X "$URL" -Atc 'select max(id) from users')
--   for start in $(seq 0 100000 "$max"); do
--     psql -X "$URL" -v active_since='2024-11-18' \
--       -v after_user_id=$start -v through_user_id=$((start + 100000)) \
--       -f scripts/sql/rails-progress-export.sql >> rails-progress.jsonl
--   done
--
-- Chunks must be appended in ascending order: the importer refuses an
-- unsorted file. -X skips ~/.psqlrc, whose settings (\timing, for one) would
-- add lines the importer refuses. The counts file takes the same parameters
-- and reports how many lines and entries to expect. Pass the same -v active_since='YYYY-MM-DD' to every chunk so
-- they share one cutoff instead of each computing its own from now().
--
-- Output: JSONL, one line per active user with at least one completion, ordered
-- by Rails user id ascending (the importer's resume cursor depends on that):
--
--   {"railsUserId":1,"email":"a@example.com","lastActiveAt":"…Z",
--    "lessons":[{"railsLessonId":10,"slug":"…","completedAt":"…Z"}],
--    "series":[{"railsPlaylistId":5,"railsSeriesId":null,"slug":"…","completedAt":"…Z"}]}
--
-- Completion rules, matching what Rails shows learners today
-- (`Lesson.completed_by_user`, `SeriesProgress#completed_lessons`):
--   * a lesson counts as completed when the user has a lesson_view with
--     did_complete = true on the lesson's CURRENT lesson version. Rails does not
--     show completions of superseded versions, so they are not exported.
--   * Rails has no completed_at for lessons. completedAt is the latest
--     updated_at (falling back to created_at) of the user's completed views.
--   * series progress is exported only when is_complete = true on egghead.io,
--     with completed_at falling back to updated_at.
--
-- The output contains learner emails. Keep it in desk scratch; never commit it
-- or copy it into shared notes.

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
\set FETCH_COUNT 1000

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

-- Rails stores datetimes as `timestamp without time zone` holding UTC
-- (ActiveRecord default_timezone is :utc; config.time_zone is display only),
-- so the cutoff is computed in UTC and timestamps are stamped "Z" below.
WITH cutoff AS (
  SELECT COALESCE(
    NULLIF(:'active_since', '')::timestamp,
    (now() AT TIME ZONE 'UTC') - :'active_window'::interval
  ) AS at
),
recent_view_users AS (
  SELECT lv.user_id, MAX(COALESCE(lv.updated_at, lv.created_at)) AS last_at
  FROM lesson_views lv, cutoff
  WHERE lv.user_id IS NOT NULL
    AND lv.user_id > :after_user_id
    AND lv.user_id <= :through_user_id
    AND COALESCE(lv.updated_at, lv.created_at) >= cutoff.at
  GROUP BY lv.user_id
),
recent_series_users AS (
  SELECT sp.user_id, MAX(GREATEST(sp.updated_at, sp.last_lesson_watched_at)) AS last_at
  FROM series_progresses sp, cutoff
  WHERE sp.user_id IS NOT NULL
    AND sp.user_id > :after_user_id
    AND sp.user_id <= :through_user_id
    AND GREATEST(sp.updated_at, sp.last_lesson_watched_at) >= cutoff.at
  GROUP BY sp.user_id
),
active_users AS (
  SELECT
    u.id,
    lower(trim(u.email)) AS email,
    GREATEST(
      u.current_sign_in_at,
      u.last_sign_in_at,
      rv.last_at,
      rs.last_at
    ) AS last_active_at
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
  SELECT
    lv.user_id,
    l.id AS lesson_id,
    l.slug,
    MAX(COALESCE(lv.updated_at, lv.created_at)) AS completed_at
  FROM lesson_views lv
  JOIN active_users au ON au.id = lv.user_id
  JOIN lessons l
    ON l.id = lv.lesson_id
   AND lv.lesson_version_id = l.current_lesson_version_id
  WHERE lv.did_complete
  GROUP BY lv.user_id, l.id, l.slug
),
lessons_by_user AS (
  SELECT
    user_id,
    json_agg(
      json_build_object(
        'railsLessonId', lesson_id,
        'slug', slug,
        'completedAt', to_char(completed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
      ORDER BY lesson_id
    ) AS lessons
  FROM completed_lessons
  GROUP BY user_id
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
    END AS series_id,
    MAX(COALESCE(sp.completed_at, sp.updated_at)) AS completed_at
  FROM series_progresses sp
  JOIN active_users au ON au.id = sp.user_id
  WHERE sp.is_complete
    AND COALESCE(sp.site, 'egghead.io') = 'egghead.io'
  GROUP BY 1, 2, 3
),
series_by_user AS (
  SELECT
    cs.user_id,
    json_agg(
      json_build_object(
        'railsPlaylistId', cs.playlist_id,
        'railsSeriesId', cs.series_id,
        'slug', COALESCE(p.slug, s.slug),
        'completedAt', to_char(cs.completed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
      ORDER BY cs.playlist_id NULLS LAST, cs.series_id NULLS LAST
    ) AS series
  FROM completed_series cs
  LEFT JOIN playlists p ON p.id = cs.playlist_id
  LEFT JOIN series s ON s.id = cs.series_id
  WHERE cs.playlist_id IS NOT NULL OR cs.series_id IS NOT NULL
  GROUP BY cs.user_id
)
SELECT json_build_object(
  'railsUserId', au.id,
  'email', au.email,
  'lastActiveAt', to_char(au.last_active_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'lessons', COALESCE(lbu.lessons, '[]'::json),
  'series', COALESCE(sbu.series, '[]'::json)
)::text
FROM active_users au
LEFT JOIN lessons_by_user lbu ON lbu.user_id = au.id
LEFT JOIN series_by_user sbu ON sbu.user_id = au.id
WHERE lbu.user_id IS NOT NULL OR sbu.user_id IS NOT NULL
ORDER BY au.id;

ROLLBACK;
