import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { Suspense } from "react";
import { Container } from "@egghead/ui/container";
import { SectionHeader, Stack } from "@egghead/ui/structure";

import { searchContentPage, type SearchResultsPage } from "../../../content/search";
import {
  contentTypeFromSearchParams,
  firstSearchParamValue,
  instructorFromSearchParams,
  searchTermFromRoute,
  type SearchRouteParams,
  type SearchRouteSearchParams,
} from "../../../content/search-route";
import { SearchInstructorFilter } from "./search-instructor-filter";
import { searchHref } from "./search-href";
import { SearchPaginationLabel } from "./search-pagination-label";
import { SearchTypeFilter } from "./search-type-filter";

type SearchPageProps = {
  params: Promise<SearchRouteParams>;
  searchParams: Promise<SearchRouteSearchParams>;
};

type SearchRouteState = {
  cursor: string;
  contentType: string | null;
  instructor: string | null;
  term: string;
};

async function searchRouteStateFromProps(props: SearchPageProps): Promise<SearchRouteState> {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams]);

  return {
    cursor: firstSearchParamValue(searchParams.cursor),
    contentType: contentTypeFromSearchParams(searchParams),
    instructor: instructorFromSearchParams(searchParams),
    term: searchTermFromRoute({ params, searchParams }),
  };
}

export async function generateMetadata(props: SearchPageProps): Promise<Metadata> {
  const { contentType, term } = await searchRouteStateFromProps(props);
  const title = term
    ? `${term} | egghead`
    : contentType
      ? `${contentType} | egghead`
      : "Search | egghead";

  return {
    title,
    description: "Find egghead courses, lessons, articles, talks, and podcasts.",
    alternates: {
      canonical: term ? `https://egghead.io/q/${encodeURIComponent(term)}` : "https://egghead.io/q",
    },
  };
}

const countFormat = new Intl.NumberFormat("en-US");

function searchSummary(total: number, term: string, contentType: string | null) {
  const count = countFormat.format(total);
  if (term) return `${count} ${total === 1 ? "result" : "results"} for "${term}"`;
  const noun = total === 1 ? "resource" : "resources";
  return contentType ? `${count} ${contentType} ${noun}` : `${count} ${noun}`;
}

function SearchResults({
  contentType,
  resultPage,
  instructor,
  term,
}: Pick<SearchRouteState, "contentType" | "term" | "instructor"> & {
  resultPage: SearchResultsPage;
}) {
  const pageHref = (cursor?: string) =>
    searchHref({
      cursor,
      term,
      contentType: contentType || undefined,
      instructor: instructor || undefined,
    });
  const linkClass =
    "press inline-flex min-h-11 items-center gap-2 rounded-lg border border-border-strong bg-surface-grad px-4 font-extrabold text-foreground shadow-btn-ghost focus-visible:outline-2 focus-visible:outline-offset-2";
  const disabledClass =
    "inline-flex min-h-11 items-center gap-2 rounded-lg border border-transparent px-4 font-extrabold text-muted-foreground opacity-60";

  if (resultPage.kind === "stale-page") {
    return (
      <Stack gap="tight">
        <p className="egghead-empty-state" data-search-state="page-unavailable">
          This page of results is no longer available.
        </p>
        <p>
          <Link className={linkClass} href={pageHref()}>
            Back to the first page
          </Link>
        </p>
      </Stack>
    );
  }

  const { results, pagination } = resultPage;
  const { page, total, totalPages, firstIndex, lastIndex, previousCursor, nextCursor } = pagination;
  const pageLabel = `Page ${countFormat.format(page)} of ${countFormat.format(totalPages)}`;

  return (
    <Stack gap="tight">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <p className="font-hand text-2xl text-muted-foreground" data-search-total={total}>
          {searchSummary(total, term, contentType)}
        </p>
        {totalPages > 1 ? (
          <p className="text-sm font-bold text-muted-foreground tabular-nums">
            {`Showing ${countFormat.format(firstIndex)}–${countFormat.format(lastIndex)} · ${pageLabel}`}
          </p>
        ) : null}
      </div>

      {results.length > 0 ? (
        <ol
          className="egghead-search-results"
          data-search-results-count={results.length}
          data-search-term={term || "browse"}
          data-search-type={contentType || "all"}
          start={firstIndex}
        >
          {results.map((result) => (
            <li data-search-result-type={result.type} key={result.id}>
              <a href={result.href}>
                <span className="egghead-search-type">{result.type}</span>
                <span className="egghead-search-title">{result.title}</span>
                {result.description ? (
                  <span className="egghead-search-description">{result.description}</span>
                ) : null}
              </a>
            </li>
          ))}
        </ol>
      ) : (
        <p className="egghead-empty-state" data-search-state="no-results">
          No resources match this search.
        </p>
      )}
      {previousCursor || nextCursor ? (
        <nav
          aria-label="Search pagination"
          className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-6"
        >
          {previousCursor ? (
            <Link className={linkClass} href={pageHref(previousCursor)} prefetch={false} rel="prev">
              <span aria-hidden="true">←</span>
              <SearchPaginationLabel>Previous</SearchPaginationLabel>
            </Link>
          ) : (
            <span aria-disabled="true" className={disabledClass}>
              <span aria-hidden="true">←</span>
              Previous
            </span>
          )}
          <span
            aria-current="page"
            className="font-bold text-muted-foreground tabular-nums"
            data-search-page={page}
            data-search-total-pages={totalPages}
          >
            {pageLabel}
          </span>
          {nextCursor ? (
            <Link className={linkClass} href={pageHref(nextCursor)} prefetch={false} rel="next">
              <SearchPaginationLabel>Next</SearchPaginationLabel>
              <span aria-hidden="true">→</span>
            </Link>
          ) : (
            <span aria-disabled="true" className={disabledClass}>
              Next
              <span aria-hidden="true">→</span>
            </span>
          )}
        </nav>
      ) : null}
    </Stack>
  );
}

// Varied widths so the skeleton reads as real results, not a striped block.
const SKELETON_RESULTS = [
  { title: "62%", description: ["94%", "71%"] },
  { title: "48%", description: ["88%"] },
  { title: "74%", description: ["91%", "56%"] },
  { title: "41%", description: ["83%", "64%"] },
  { title: "57%", description: ["78%"] },
  { title: "66%", description: ["96%", "47%"] },
];

function SearchFallback() {
  return (
    <Stack gap="tight">
      <output className="sr-only">Loading resources.</output>
      <div aria-hidden className="egghead-skeleton-block h-8 w-44" />
      <ol aria-hidden className="egghead-search-results" data-search-state="pending">
        {SKELETON_RESULTS.map((row) => (
          <li key={row.title}>
            <div className="egghead-search-skeleton">
              <span className="egghead-skeleton-block h-3 w-16" />
              <span className="egghead-skeleton-block h-6" style={{ width: row.title }} />
              {row.description.map((width) => (
                <span className="egghead-skeleton-block h-4" key={width} style={{ width }} />
              ))}
            </div>
          </li>
        ))}
      </ol>
    </Stack>
  );
}

function SearchForm({
  contentType,
  instructor,
  term,
}: {
  contentType?: string | undefined;
  instructor?: string | undefined;
  term?: string | undefined;
}) {
  return (
    <div className="egghead-search-form w-full max-w-4xl">
      <Form action="/q" className="egghead-home-search">
        <input
          aria-label="Search egghead"
          // A dedicated search page's input is the page's purpose — focus it.
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          defaultValue={term}
          // Remount when the routed term changes so the field tracks the URL.
          key={term ?? ""}
          name="q"
          placeholder="Search courses, lessons, articles"
          type="search"
        />
        {contentType ? <input name="type" type="hidden" value={contentType} /> : null}
        {instructor ? <input name="instructor" type="hidden" value={instructor} /> : null}
        <button type="submit">Search</button>
      </Form>
      <SearchTypeFilter contentType={contentType} instructor={instructor} term={term} />
      <SearchInstructorFilter contentType={contentType} instructor={instructor} term={term} />
    </div>
  );
}

function SearchContentFallback() {
  return (
    <>
      <SearchForm />
      <SearchFallback />
    </>
  );
}

async function RoutedSearchContent(props: SearchPageProps) {
  const { contentType, instructor, term, cursor } = await searchRouteStateFromProps(props);
  const resultPage = await searchContentPage({ term, contentType, instructor }, cursor);

  return (
    <>
      <SearchForm
        contentType={contentType || undefined}
        instructor={instructor || undefined}
        term={term || undefined}
      />
      <SearchResults
        contentType={contentType}
        instructor={instructor}
        resultPage={resultPage}
        term={term}
      />
    </>
  );
}

export default function SearchPage(props: SearchPageProps) {
  return (
    <Container as="main" size="wide">
      <Stack gap="normal">
        <SectionHeader
          description="Find courses, lessons, articles, talks, and podcasts."
          eyebrow="Browse"
          title="Search"
        />
        <Suspense fallback={<SearchContentFallback />}>
          <RoutedSearchContent {...props} />
        </Suspense>
      </Stack>
    </Container>
  );
}
