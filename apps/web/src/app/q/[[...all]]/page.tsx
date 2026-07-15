import type { Metadata } from "next";
import Form from "next/form";
import { Suspense } from "react";
import { Container } from "@egghead/ui/container";
import { SectionHeader, Stack } from "@egghead/ui/structure";

import { searchContent, type SearchResult } from "../../../content/search";
import {
  contentTypeFromSearchParams,
  searchTermFromRoute,
  type SearchRouteParams,
  type SearchRouteSearchParams,
} from "../../../content/search-route";

type SearchPageProps = {
  params: Promise<SearchRouteParams>;
  searchParams: Promise<SearchRouteSearchParams>;
};

type SearchRouteState = {
  contentType: string | null;
  term: string;
};

async function searchRouteStateFromProps(props: SearchPageProps): Promise<SearchRouteState> {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams]);

  return {
    contentType: contentTypeFromSearchParams(searchParams),
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
}: SearchRouteState & {
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

function SearchFallback() {
  return (
    <p className="egghead-empty-state" data-search-state="pending">
      Loading resources.
    </p>
  );
}

function SearchForm({
  contentType,
  term,
}: {
  contentType?: string | undefined;
  term?: string | undefined;
}) {
  return (
    <Form action="/q" className="egghead-home-search w-full max-w-2xl">
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
      <button type="submit">Search</button>
    </Form>
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
  const { contentType, term } = await searchRouteStateFromProps(props);
  const results = await searchContent(term, contentType);

  return (
    <>
      <SearchForm contentType={contentType || undefined} term={term || undefined} />
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
