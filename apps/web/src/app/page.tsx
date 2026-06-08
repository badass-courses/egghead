import Link from "next/link";
import { Container } from "@egghead/ui/container";
import { SectionHeader, Stack } from "@egghead/ui/structure";

import { getHomeContent, type HomeContentItem } from "../content/home";

function SearchForm() {
  return (
    <form action="/q" className="egghead-home-search" method="get">
      <input aria-label="Search egghead" name="q" placeholder="Search courses, lessons, articles" />
      <button type="submit">Search</button>
    </form>
  );
}

function BrowseLinks() {
  return (
    <nav aria-label="Browse egghead" className="egghead-home-nav">
      <Link href="/q?type=course">Courses</Link>
      <Link href="/q?type=lesson">Lessons</Link>
      <Link href="/blog">Articles</Link>
      <Link href="/tips">Tips</Link>
      <Link href="/podcasts">Podcasts</Link>
      <Link href="/talks">Talks</Link>
    </nav>
  );
}

function ContentSection({
  title,
  description,
  items,
}: {
  title: string;
  description: string;
  items: HomeContentItem[];
}) {
  return (
    <section className="egghead-home-section">
      <div className="egghead-home-section-header">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {items.length > 0 ? (
        <ol className="egghead-search-results">
          {items.map((item) => (
            <li data-search-result-type={item.family} key={item.id}>
              <Link href={item.href}>
                <span className="egghead-search-type">{item.family}</span>
                <span className="egghead-search-title">{item.title}</span>
                {item.description ? (
                  <span className="egghead-search-description">{item.description}</span>
                ) : null}
              </Link>
            </li>
          ))}
        </ol>
      ) : (
        <p className="egghead-empty-state">No content is available yet.</p>
      )}
    </section>
  );
}

export default async function Home() {
  const content = await getHomeContent();

  return (
    <Container as="main" size="wide">
      <Stack gap="loose">
        <SectionHeader
          description="Courses, lessons, articles, talks, podcasts, and field notes for working developers."
          eyebrow="Learn from working developers"
          title="egghead"
        />
        <SearchForm />
        <BrowseLinks />
        <ContentSection
          description="Structured courses and their lessons."
          items={content.courses}
          title="Courses"
        />
        <ContentSection
          description="Articles, talks, podcasts, tips, and project notes."
          items={content.resources}
          title="Latest"
        />
      </Stack>
    </Container>
  );
}
