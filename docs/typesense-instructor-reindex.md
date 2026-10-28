# Instructor search and safe reindex investigation

## Verified cause

The live canonical collection schema predates the instructor fields in source. Faceting
`instructorNames` produces a Typesense 404. Deployment of source did not alter an existing
collection. The previous indexing command could only change it through destructive recreation.
Canonical instructor discovery also used SQL, while the intended beta migration source had
zero contribution rows; this independently explains its successful empty instructor responses.

## Source reconciliation, 2026-10-28

Counts-only, read-only probes used one-hour PlanetScale reader leases and a TLS-verified,
read-only Rails connection. No customer rows, emails, or credentials are recorded here.

- Old canonical index: 10,703 documents, no instructor fields, no aliases.
- Migration source: 23,547 total resources; 6,639 currently searchable documents.
- Every old index ID exists in that source. Of those, 4,040 are soft-deleted, 41 have types
  outside the current search contract, and 6,622 remain eligible. The current source also
  adds 17 eligible documents. Fewer indexed documents therefore do not imply missing migration
  rows. The workflow confirms exclusions through the same SQL publication predicate used to
  build documents; absent rows still block the build.
- Rails has 372 instructors, all matching existing named users by legacy Rails user ID.
- Backfill dry run: 7,202 live lesson/course resources, 7,201 mappings, zero conflicts or
  blocked mappings, one unmatched course left unchanged. The source had zero contributions.
- The alternative main branch produces 10,863 search documents with only 459 containing
  contributions and a materially different catalog. It was inspected, not modified.

## Implementation and verification

`pnpm search:typesense-contract` exercises the real SDK against local HTTP fixtures, including
canonical/legacy facets, failed imports, schema/count/facet mismatches, version collisions,
source omissions, publication-confirmed exclusions, source drift, alias races, denied reads /
writes, first-alias rollback, applied-but-erroring PUTs, rollback denial, and 201 documents in
three import batches. A reader-only preflight works without an operator key.

Controlled mutations changed the canonical facet, bypassed the document-count and exclusion
guards, broke rollback restoration, and bypassed backfill ID precedence. Each caused the contract to fail; restored code passed.

The final `pnpm check` passed: both typecheckers, lint, formatting, all contracts, beta commerce
guards, and builder runtime smoke checks. The live reader-only preflight rejects the existing
incompatible schema as expected. The actual exclusion adapter confirmed all 4,081 omitted
baseline IDs with zero unexplained missing IDs.

Backfill mapping contracts cover stable IDs, exact unique slugs, missing or blank identities,
conflicting ID/slug matches, deterministic IDs across ordering changes, and unmatched resources.
The live dry run independently confirmed 7,201 resolvable mappings in about 20 seconds.

EXPLAIN evidence: instructor identity lookup uses `legacyRailsUserId_idx`, access `range`,
estimate 2 rows for a two-ID probe. Resource pagination uses `PRIMARY`, access `range`, with
an ordered 500-row limit. Contribution reads use an indexed type/content lookup. Full Rails
authorship reads are bounded snapshot scans, not user-table scans. A broad exploratory user
aggregate was stopped after proving unsuitable; the implementation uses only indexed identity
lookups. No larger timeout or disabled check was introduced.

## Rollout status

Implementation and validation are in progress. The contribution apply and Typesense promotion
require the content-write freeze to be confirmed. No Typesense collection, alias, or beta
configuration has been changed yet. Existing collections are retained for rollback.

The original 781e checkout was removed by Codex during this task. Its changes were recovered
from archive snapshot b041947 into the current checkout and continued on
`zac/typesense-instructor-reindex`.
