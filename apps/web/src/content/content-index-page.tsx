import Link from "next/link";
import { Container } from "@egghead/ui/container";
import { SectionHeader, Stack } from "@egghead/ui/structure";

import type { ContentIndex } from "./content-index";

function countDescription(index: ContentIndex) {
  const visibleCount = index.items.length;
  const countText =
    index.totalCount > visibleCount
      ? `${visibleCount} latest of ${index.totalCount}`
      : `${index.totalCount}`;

  return `${index.description} ${countText} ${index.title.toLowerCase()}.`;
}

export async function ContentIndexPage({ index }: { index: ContentIndex }) {
  "use cache";

  return (
    <Container as="main" size="wide">
      <Stack gap="loose">
        <SectionHeader
          description={countDescription(index)}
          eyebrow={index.eyebrow}
          title={index.title}
        />

        {index.items.length > 0 ? (
          <ol
            className="egghead-search-results"
            data-content-index={index.family}
            data-content-index-count={index.totalCount}
          >
            {index.items.map((item) => (
              <li data-search-result-type={item.family} key={item.id}>
                <Link href={item.href}>
                  <span className="egghead-search-type">{index.itemLabel}</span>
                  <span className="egghead-search-title">{item.title}</span>
                  {item.description ? (
                    <span className="egghead-search-description">{item.description}</span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ol>
        ) : (
          <p className="egghead-empty-state" data-content-index-empty={index.family}>
            No content is available yet.
          </p>
        )}
      </Stack>
    </Container>
  );
}
