# Lesson access

Courses, course-linked lessons, and explicitly pro standalone lessons gate.
A resolved lesson-level free marking always wins. Author-free CourseBuilder
posts without a Rails pro signal stay free.

## Automated proof

`pnpm check` runs `test/content/lesson-access.test.ts` and
`test/content/lesson-playback.test.ts`. These cover all four explicit pro signals,
signed-out denial, subscription access, author-free posts, and free course lessons.
Set `LESSON_ACCESS_MYSQL_URL` to a disposable loopback `_test` database to also
execute the SQL/TypeScript fixture matrix. It reads derived JSON rows, not tables.

## Named beta live-proof items

Vitelline reported that beta rendered an HLS video source signed out for these
Rails lesson IDs while egghead.io showed no playback:

- **6621**
- **5736**
- **8160**
- **6612**
- **5741**

This is a reported symptom, not a verified classification of their current rows.
For each lesson, after the gate is deployed:

1. Resolve the served lesson row and route. Confirm its course linkage and Rails
   pro marking. Check both Rails pro field spellings and the older `freeAccess`
   mirror; do not infer paid intent from the lesson ID alone.
2. If the lesson is explicitly pro and standalone, confirm its resolved free
   marking is false. A stale imported `isProContent: false` remains a separate
   data-repair prerequisite; do not override free-marking precedence in code.
3. Load the route in a fresh signed-out session. Require a gated player state,
   no HTML video/source playback `src`, and no mounted Mux player. Inspect
   attribute presence without printing or recording media URLs.
4. Load the same route as a paying user with a granting entitlement. Require
   playable video through the existing entitlement check.
5. Record the lesson ID, deployed commit, confirmed classification, and booleans
   for signed-out gating, absence of playback source, and paying-user playback.
   Keep media URLs, customer identity, and tokens out of the receipt.

Also check author-free `install-three-js-and-types-three~unnm9` and a
free-forever course lesson remain on the free playback path. The named beta
checks are pending until a deployed candidate is verified; synthetic fixtures
are not proof of these live rows.
