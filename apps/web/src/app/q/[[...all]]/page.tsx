import type { Metadata } from "next";
import { Container } from "@egghead/ui/container";
import { SectionHeader, Stack } from "@egghead/ui/structure";

import { searchContent } from "../../../content/search";

type SearchPageProps = {
  params: Promise<{
    all?: string[];
  }>;
  searchParams: Promise<{
    q?: string | string[];
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

export async function generateMetadata(props: SearchPageProps): Promise<Metadata> {
  const term = await searchTermFromProps(props);
  const title = term ? `${term} | egghead` : "Search | egghead";

  return {
    title,
    description: "Find retained egghead courses and lessons.",
    alternates: {
      canonical: term ? `https://egghead.io/q/${encodeURIComponent(term)}` : "https://egghead.io/q",
    },
  };
}

export default async function SearchPage(props: SearchPageProps) {
  const term = await searchTermFromProps(props);
  const results = await searchContent(term);

  return (
    <Container as="main" size="wide">
      <Stack gap="loose">
        <SectionHeader
          description={
            term ? `${results.length} results for ${term}` : `${results.length} retained resources`
          }
          eyebrow="Browse"
          title="Search"
        />

        {results.length > 0 ? (
          <ol
            className="egghead-search-results"
            data-search-results-count={results.length}
            data-search-term={term || "browse"}
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
            No retained resources match this search.
          </p>
        )}
      </Stack>
    </Container>
  );
}
