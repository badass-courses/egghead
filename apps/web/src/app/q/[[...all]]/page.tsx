import type { Metadata } from "next";
import Form from "next/form";
import { Suspense } from "react";
import { Container } from "@egghead/ui/container";
import { SectionHeader, Stack } from "@egghead/ui/structure";

import { searchContent, type SearchResult } from "../../../content/search";
import {
  contentTypeFromSearchParams,
  instructorFromSearchParams,
  searchTermFromRoute,
  type SearchRouteParams,
  type SearchRouteSearchParams,
} from "../../../content/search-route";
import { SearchInstructorFilter } from "./search-instructor-filter";
import { SearchTypeFilter } from "./search-type-filter";

type SearchPageProps = {
  params: Promise<SearchRouteParams>;
  searchParams: Promise<SearchRouteSearchParams>;
};

type SearchRouteState = {
  contentType: string | null;
  instructor: string | null;
  term: string;
};

async function searchRouteStateFromProps(props: SearchPageProps): Promise<SearchRouteState> {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams]);

  return {
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

function SearchResults({
  contentType,
  results,
  term,
}: Pick<SearchRouteState, "contentType" | "term"> & {
  results: SearchResult[];
}) {
  return (
    <Stack gap="tight">
      <p className="font-hand text-2xl text-muted-foreground">
        {term
          ? `${results.length} results for "${term}"`
          : contentType
            ? `${results.length} ${contentType} resources`
            : `${results.length} resources`}
      </p>

      {results.length > 0 ? (
        <ol
          className="egghead-search-results"
          data-search-results-count={results.length}
          data-search-term={term || "browse"}
          data-search-type={contentType || "all"}
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
  const { contentType, instructor, term } = await searchRouteStateFromProps(props);
  const results = await searchContent(term, contentType, instructor);

  return (
    <>
      <SearchForm
        contentType={contentType || undefined}
        instructor={instructor || undefined}
        term={term || undefined}
      />
      <SearchResults contentType={contentType} results={results} term={term} />
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
