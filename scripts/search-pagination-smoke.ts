import assert from "node:assert/strict";
import { z } from "zod";

const base = process.env["SEARCH_SMOKE_URL"] ?? "http://localhost:3008";

function decodeHtml(value: string) {
  return value.replaceAll("&amp;", "&").replaceAll("&#x27;", "'").replaceAll("&quot;", '"');
}

async function readPage(path: string) {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(60_000) });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.doesNotMatch(html, /data-next-error|ECONNREFUSED/);
  const list = html.match(/<ol[^>]*data-search-results-count[^>]*>([\s\S]*?)<\/ol>/)?.[1] ?? "";
  const links = [...list.matchAll(/<a href="([^"]+)"/g)].map((match) => match[1]);
  function paginationLink(relation: string) {
    const tag = html.match(new RegExp(`<a[^>]*rel="${relation}"[^>]*>`))?.[0];
    const href = tag?.match(/href="([^"]+)"/)?.[1];
    return href ? decodeHtml(href) : null;
  }
  const total = Number(html.match(/data-search-total="(\d+)"/)?.[1] ?? Number.NaN);
  const page = html.match(/data-search-page="(\d+)" data-search-total-pages="(\d+)"/);
  return {
    html,
    links,
    next: paginationLink("next"),
    previous: paginationLink("prev"),
    page: Number(page?.[1] ?? 1),
    total,
    totalPages: Number(page?.[2] ?? 1),
  };
}

const first = await readPage("/q?q=react");
assert.ok(Number.isFinite(first.total));
assert.equal(first.previous, null);
assert.equal(first.totalPages, Math.max(1, Math.ceil(first.total / 24)));
assert.equal(first.links.length, Math.min(24, first.total));
if (first.next) {
  const second = await readPage(first.next);
  assert.equal(second.page, 2);
  assert.equal(
    second.links.some((link) => first.links.includes(link)),
    false,
    "Pages must not overlap",
  );
  assert.ok(second.previous);
  assert.deepEqual((await readPage(second.previous)).links, first.links);
  if (second.next) {
    const third = await readPage(second.next);
    assert.ok(third.previous);
    assert.deepEqual((await readPage(third.previous)).links, second.links);
  }
  const staleCursor = new URL(first.next, base).searchParams.get("cursor");
  assert.ok(staleCursor);
  assert.deepEqual(
    (await readPage(`/q?q=typescript&cursor=${encodeURIComponent(staleCursor)}`)).links,
    (await readPage("/q?q=typescript")).links,
    "Changing the search must invalidate an old cursor",
  );
}
assert.deepEqual((await readPage("/q?q=react&cursor=invalid")).links, first.links);
const empty = await readPage("/q?q=pr40-pagination-no-matches-482bd");
assert.equal(empty.total, 0);
assert.equal(empty.next, null);
assert.ok(empty.html.includes('data-search-state="no-results"'));

// The live catalog supplies display names; exact boundary cases belong to fixture tests.
const instructorsResponse = await fetch(new URL("/api/instructors", base), {
  signal: AbortSignal.timeout(60_000),
});
assert.equal(instructorsResponse.status, 200);
const { instructors } = z
  .object({ instructors: z.array(z.object({ name: z.string() })) })
  .parse(await instructorsResponse.json());
const instructor = instructors[0]?.name;
assert.ok(instructor, "Configured catalog must expose an instructor for filter smoke coverage");
const filtered = await readPage(`/q?type=course&instructor=${encodeURIComponent(instructor)}`);
assert.ok(Number.isFinite(filtered.total));
assert.equal(filtered.totalPages, Math.max(1, Math.ceil(filtered.total / 24)));
if (filtered.next) {
  const nextUrl = new URL(filtered.next, base);
  assert.equal(nextUrl.searchParams.get("type"), "course");
  assert.equal(nextUrl.searchParams.get("instructor"), instructor);
  const second = await readPage(filtered.next);
  assert.equal(
    second.links.some((link) => filtered.links.includes(link)),
    false,
  );
  assert.ok(second.previous);
  assert.deepEqual((await readPage(second.previous)).links, filtered.links);
}
console.log(
  "Search pagination smoke passed: current catalog totals, navigation, invalid/stale cursors, instructor filters, and empty results.",
);
