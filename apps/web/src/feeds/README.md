# Feeds (Rails parity)

Ports the five RSS feeds egghead-rails served (`config/routes.rb` feed block,
`app/views/**/*.rss.builder`) onto CourseBuilder content. They keep the Rails
URL paths, so no redirects are needed. The route-parity redirect table leaves
these paths alone.

| Rails route                    | Rails action              | CB route file                               | Auth   |
| ------------------------------ | ------------------------- | ------------------------------------------- | ------ |
| `/feed`, `/lessons/feed`       | `lessons#feed`            | `app/feed/route.ts`, `app/lessons/feed`     | public |
| `/lessons/pro_feed?tech=`      | `lessons#pro_feed`        | `app/lessons/pro_feed/route.ts`             | token  |
| `/courses/:id/course_feed`     | `series#course_feed`      | `app/courses/[course]/course_feed/route.ts` | token  |
| `/playlists/:id/playlist_feed` | `playlists#playlist_feed` | `app/playlists/[id]/playlist_feed/route.ts` | token  |
| `/instructors/:id/feed`        | `instructors#feed`        | `app/instructors/[id]/feed/route.ts`        | token  |
| `/i/:slug/rss.xml`             | egghead-next (not Rails)  | `app/i/[slug]/rss.xml/route.ts`             | public |

`/i/:slug/rss.xml` reads the legacy Typesense collection
(`EGGHEAD_INSTRUCTOR_FEED_TYPESENSE_COLLECTION`, default `content_production`,
independent of the search page's collection) with the search host and key.
Its GUIDs are `https://egghead.io` plus each document's `path`. Without
`NEXT_PUBLIC_TYPESENSE_HOST` and `NEXT_PUBLIC_TYPESENSE_API_KEY` it answers 503
(retryable). They are read at request time, but a Vercel deployment only sees
the env it was built with, so an env change needs a redeploy. Any Typesense
error (for example a key without access to the collection) is also a 503,
logged as `[feeds] instructor podcast feed failed`.

Rails also answered each route with a `.rss` suffix (`/feed.rss` returned 200).
`feeds/rewrites.ts` rewrites those six suffixed paths to the same handlers
(`beforeFiles` in `next.config.ts`); query strings pass through.

Every feed route renders per request (`await connection()`), served from the
hours-long content cache, and is never prerendered at build time. Unknown
feeds are cached for minutes.

## GUIDs

Every Rails item GUID was the canonical permalink, with no query string:

- lessons: `https://egghead.io/lessons/<slug>`
- courses and playlists in `/feed`: `https://egghead.io/courses/<slug>` (Rails `series_url`)
- instructor feed (`polymorphic_url`): a Series gets `/courses/<slug>` and a Playlist gets
  `/playlists/<slug>`. `FeedCourse.railsOrigin` makes that choice. A CB course is a Rails
  playlist (`eggheadPlaylistId`) unless it carries only a Series id (`legacyRailsSeriesId`
  or `eggheadSeriesId`).

`rails-parity.ts` rebuilds these from the Rails slug: `legacyRailsSlug`
(backfill), then `legacyRailsLessonSlug` (migrated rows), then `fields.slug`.

One Rails lesson or playlist can exist twice in CB: the migrated row
(`eh_lesson_*`, Rails slug, `publishedAt`) and a CB-native post with a new
slug, both pointing at the same `eggheadLessonId` or `eggheadPlaylistId`. The
feeds merge them into one item per Rails id. Identity (GUID slug, publish
date) comes from the row carrying the Rails slug, then the one with a publish
date. Content (title, summary, video, tags) comes from the CB-native post,
because that is the row editors change. Ties break by id. Parity reports how
many such groups exist; lesson pages and search see both rows (not changed
here).

Course and playlist feed URLs carry the Rails slug. When only a CB-native
course with a new slug exists, the lookup also matches `legacyRailsSlug` and
`legacyRailsPlaylistSlug`.

A JSON `null` in a field counts as missing everywhere (ordering, filters,
backfill planning and its write guard). Podcasts are Rails lessons and appear as lessons.
Dates come from MySQL as UTC epoch milliseconds, so the process time zone
never shifts them. Keep them byte-identical, or every subscriber
re-downloads the whole back catalog.

## Ids in URLs

Rails friendly finders took a slug or a numeric id of the controller's own
model. A numeric `course_feed` id is a Series id, and a numeric `playlist_feed`
id is a Playlist id. They are never crossed: CB records no Series ids today,
so numeric `course_feed` ids return 404.

## Publication

`feedPublicationSql` in `content.ts` is the one rule:

- lessons: state `published`, `flagged` or `revised`
- courses: state `published`
- `/feed` additionally requires `visibilityState = indexed` (or the migrated
  `public`) and `visibility = public`. When the migrated `railsVisibilityState`
  is present it must be `indexed` too: the migration wrote `public` for some
  rows Rails had hidden. It only narrows; a CB `hidden` still hides. The same
  rule picks an instructor's indexed playlists.
- blocked visibility values are always excluded

Rails `Lesson.without_series` is `series_id IN (0, NULL)`. Only the legacy
Series model set `series_id`; CB courses are Rails playlists, so lessons in CB
courses still appear in `/feed` and the instructor feed. A lesson is excluded
only if its fields carry a Rails Series id. Selection windows order by
`fields.publishedAt`, as Rails ordered by `published_at`.

`?tech=` matches tag names (Rails `tagged_with`; names are lowercased) or slugs.

## Token auth

Rails: `?user_email=<email>&user_token=<users.authentication_token>`. The user
had to be pro (not trialing) or an instructor. CB looks the token up by
SHA-256 in `egghead_LegacyFeedToken` (`db/legacy-feed-tokens.ts`) and accepts
the URL email if it matches either the Rails email captured at import (stored
as `railsEmailSha256`) or the CB user's email, case-insensitively. A CB user
without an email gets 403. Revoked rows are refused. It then requires a broad
entitlement (`access/evaluate.ts`) or the `admin` or `contributor` role. Every
refusal returns 403, a store outage returns a retryable 503, and a malformed
URL segment returns 404.

## Import the desk must run

1. Ship the schema. This repo has no migrations folder: schema changes live in
   `src/db/schema.ts` and reach a database through `drizzle-kit push`
   (`drizzle.config.ts`, `tablesFilter: ["egghead_*"]`). On PlanetScale, push to a
   development branch and promote it with a deploy request. The change is additive:
   one new table, `egghead_LegacyFeedToken`.
2. Export from egghead-rails (Postgres with pgcrypto), hashed in SQL so raw tokens and emails
   never leave it:
   ```sql
   \copy (SELECT id AS rails_user_id,
                 encode(digest(authentication_token, 'sha256'), 'hex') AS token_sha256,
                 encode(digest(lower(btrim(email)), 'sha256'), 'hex') AS email_sha256
          FROM users
          WHERE authentication_token IS NOT NULL AND authentication_token <> ''
          ORDER BY id) TO 'export.csv' WITH CSV HEADER
   ```
3. Dry run with `pnpm feeds:import-tokens export.csv`. It prints counts only, including how
   many active rows it would revoke.
4. Apply with `pnpm feeds:import-tokens export.csv --apply`, `EGGHEAD_RUNTIME=production`
   and `EGGHEAD_FEED_TOKEN_IMPORT_APPROVED=true`. Beta writes are refused.
5. The import is a full sync:
   - rows for users absent from the export are revoked (`absent_from_rails_export`);
   - a changed hash replaces the old one;
   - manual revocations stay.
     Revoking more than 25 rows and more than 10% of active rows needs
     `--allow-mass-revoke`. An empty export is refused. Re-run it close to the flip.

## Rails publish dates and slugs (desk-run backfill)

CB posts never kept the Rails publish time: the builder wrote `published_at`
only to Rails. On beta only a few hundred rows carry `fields.publishedAt`, so
most items fall back to `createdAt`. Some CB slugs also differ from the Rails
slug. `pnpm feeds:backfill-rails` copies both from a Rails export into CB
fields, matched by `eggheadLessonId` / `eggheadPlaylistId` (or the
`legacyRails*Id` fields):

1. Export with `RAILS_FEED_FIELDS_EXPORT_SQL` (`feeds/rails-backfill.ts`) via psql `\copy … WITH CSV HEADER`.
2. Dry run: `pnpm feeds:backfill-rails rails-feed-fields.csv` (counts only).
3. Apply: add `--apply --rollback-file <new path>` and `EGGHEAD_FEED_BACKFILL_APPROVED=true`
   (plus the usual beta or production runtime guards; local Docker needs no approval).
4. Undo: `pnpm feeds:backfill-rails --rollback <rollback file> --apply`.

The export takes every lesson with a slug, and only playlists with a publish date (Rails holds
over a million user playlists; the published ones are the feed content). `--show-conflicts`
lists every disagreement (kind, Rails id, CB id, CB value, Rails value), and the summary splits
`publishedAt` conflicts into `railsDateNewer` and `cbDateNewer`.

The migration read Rails' UTC `published_at` as Pacific wall time, so some migrated CB dates are
the Rails instant plus the Los Angeles offset (beta: all 78 conflicts, +7h or +8h).
`--fix-pacific-shift` overwrites exactly those (offset taken at the Rails instant, to the
millisecond), records the old value in the rollback file, and leaves every other conflict alone.
The summary reports `publishedAtEqual`, `pacificShifted` and `otherDateConflicts`.

It only adds a missing `publishedAt` or `legacyRailsSlug` (`JSON_SET` guarded on the key
being absent or JSON null), never overwrites (except `--fix-pacific-shift`), reports
disagreements as conflicts, skips draft rows, and is a no-op on re-run. The rollback file is
written before the first update and never overwritten. Rollback changes a key only while it
still holds the exact value this backfill wrote. Each apply writes its own rollback file:
after a partial apply and a re-run, undo both, newest first. The feeds read both keys at
runtime.

## Tests

- `pnpm feeds:test`: pure builders, RSS validation (no empty elements), GUID parity and token logic.
- `FEEDS_MYSQL_URL_FILE=<file> pnpm feeds:mysql-test` (a file holding a disposable MySQL URL): runs the real SQL
  readers, the token store with the real membership rule, and the import (dry run, apply,
  full-sync revocation, guards). It always uses its own `<stem>_feeds_test` database on a
  loopback host, creates and stamps it, refuses to push the schema into a database it did not
  create, and deletes only the ids it seeds.

## Parity against a saved Rails feed

`pnpm feeds:parity --rails <saved-feed.xml> --feed lessons` runs the shipped `/feed` reader and
builder against `DATABASE_URL` and diffs GUIDs with the saved Rails feed. The member feeds
work the same way: `--feed pro [--tech react,node]`, `--feed course --param <id or slug>` and
`--feed playlist --param <id or slug>`. Save the Rails XML with any member's feed token; the
script never reads a token. Miss reasons follow each feed's Rails scopes (only `/feed` is
indexed and `without_series`), and window reasons appear only when CB hit its item limit. Rails items newer than
the database's newest content row are reported separately. Every connection is a read-only
session and refuses non-read statements (`EGGHEAD_DB_READ_ONLY`). For beta:
`EGGHEAD_RUNTIME=beta EGGHEAD_BETA_DB_APPROVED=true DATABASE_URL=… pnpm feeds:parity …`.
