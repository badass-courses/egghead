import type { Metadata } from "next";
import Form from "next/form";
import { Suspense } from "react";
import { Container } from "@egghead/ui/container";
import { SectionHeader, Stack } from "@egghead/ui/structure";

import { searchContent } from "../../../content/search";
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

async function searchTermFromProps(props: SearchPageProps) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams]);
  return searchTermFromRoute({ params, searchParams });
}

async function contentTypeFromProps(props: SearchPageProps) {
  const searchParams = await props.searchParams;
  return contentTypeFromSearchParams(searchParams);
}

export async function generateMetadata(props: SearchPageProps): Promise<Metadata> {
  const [term, contentType] = await Promise.all([
    searchTermFromProps(props),
    contentTypeFromProps(props),
  ]);
  const title = term
    ? `${term} | egghead`
    : contentType
      ? `${contentType} | egghead`
      : "Search | egghead";

  return {
    title,
    description: "Find egghead courses, lessons, articles, talks, podcasts, and tips.",
    alternates: {
      canonical: term ? `https://egghead.io/q/${encodeURIComponent(term)}` : "https://egghead.io/q",
    },
  };
}

async function SearchResults(props: SearchPageProps) {
  const [term, contentType] = await Promise.all([
    searchTermFromProps(props),
    contentTypeFromProps(props),
  ]);
  const results = await searchContent(term, contentType);

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

async function RoutedSearchForm(props: SearchPageProps) {
  const [term, contentType] = await Promise.all([
    searchTermFromProps(props),
    contentTypeFromProps(props),
  ]);

  return <SearchForm contentType={contentType || undefined} term={term || undefined} />;
}

export default function SearchPage(props: SearchPageProps) {
  return (
    <Container as="main" size="wide">
      <Stack gap="normal">
        <SectionHeader
          description="Find courses, lessons, articles, talks, podcasts, and tips."
          eyebrow="Browse"
          title="Search"
        />
        <Suspense fallback={<SearchForm />}>
          <RoutedSearchForm {...props} />
        </Suspense>
      </Stack>
      <Suspense fallback={<SearchFallback />}>
        <SearchResults {...props} />
      </Suspense>
    </Container>
  );
}
