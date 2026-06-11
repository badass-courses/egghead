import type { Metadata } from "next";
import { Suspense } from "react";
import { Container } from "@egghead/ui/container";
import { SectionHeader } from "@egghead/ui/structure";

import { searchContent } from "../../../content/search";

type SearchPageProps = {
  params: Promise<{
    all?: string[];
  }>;
  searchParams: Promise<{
    q?: string | string[];
    type?: string | string[];
  }>;
};

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

async function searchTermFromProps(props: SearchPageProps) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams]);
  const pathTerm = params.all?.join(" ") ?? "";
  return firstValue(searchParams.q) || pathTerm;
}

async function contentTypeFromProps(props: SearchPageProps) {
  const searchParams = await props.searchParams;
  return firstValue(searchParams.type);
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
    <>
      <SectionHeader
        description={
          term
            ? `${results.length} results for ${term}`
            : contentType
              ? `${results.length} ${contentType} resources`
              : `${results.length} resources`
        }
        eyebrow="Browse"
        title="Search"
      />

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
    </>
  );
}

function SearchFallback() {
  return (
    <>
      <SectionHeader description="Loading resources." eyebrow="Browse" title="Search" />
      <p className="egghead-empty-state" data-search-state="pending">
        Loading resources.
      </p>
    </>
  );
}

export default function SearchPage(props: SearchPageProps) {
  return (
    <Container as="main" size="wide">
      <Suspense fallback={<SearchFallback />}>
        <SearchResults {...props} />
      </Suspense>
    </Container>
  );
}
