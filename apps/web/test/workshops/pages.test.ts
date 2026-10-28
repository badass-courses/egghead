import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runtime: vi.fn(() => "production"),
  workshop: vi.fn(async (_slug: string) => null),
  references: vi.fn(async () => [{ slug: "synthetic-workshop", updatedAt: "2030-01-01" }]),
  execute: vi.fn(async (statement: string) => [
    statement.includes("AS path, course.updatedAt")
      ? [{ path: "synthetic-course", updatedAt: "2030-01-01" }]
      : [],
    [],
  ]),
  end: vi.fn(async () => undefined),
}));

vi.mock("next/cache", () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));
vi.mock("../../src/db/local-docker", () => ({
  getEggheadRuntime: mocks.runtime,
  createLocalMysqlConnection: async () => ({ execute: mocks.execute, end: mocks.end }),
}));
vi.mock("../../src/content/resource-slug", () => ({
  contentResourceSlugSql: async () => "resource.slug",
}));
vi.mock("../../src/workshops/read", () => ({
  getWorkshopBySlug: mocks.workshop,
  getWorkshopReferences: mocks.references,
}));
vi.mock("../../src/content/workshop-page", () => ({ WorkshopPage: () => null }));

import { generateMetadata } from "../../src/app/workshops/[slug]/page";
import { getEggheadSitemapEntriesUncached } from "../../src/content/sitemap";

afterEach(() => {
  vi.clearAllMocks();
  mocks.references.mockReset();
  mocks.references.mockResolvedValue([{ slug: "synthetic-workshop", updatedAt: "2030-01-01" }]);
});

it("passes an already decoded percent sign to workshop lookup", async () => {
  await expect(generateMetadata({ params: Promise.resolve({ slug: "100%" }) })).resolves.toEqual(
    {},
  );
  expect(mocks.workshop).toHaveBeenCalledWith("100%");
});

it("keeps the production sitemap available without invoking blocked workshop reads", async () => {
  mocks.runtime.mockReturnValue("production");
  mocks.references.mockRejectedValueOnce(new Error("Production workshop reads are blocked"));
  const entries = await getEggheadSitemapEntriesUncached();
  expect(entries).toContainEqual(expect.objectContaining({ url: "https://egghead.io/courses" }));
  expect(entries).toContainEqual(
    expect.objectContaining({ url: "https://egghead.io/synthetic-course" }),
  );
  expect(mocks.references).not.toHaveBeenCalled();
  expect(mocks.end).toHaveBeenCalledOnce();
});

it("includes workshop references in the local sitemap", async () => {
  mocks.runtime.mockReturnValue("local");
  const entries = await getEggheadSitemapEntriesUncached();
  expect(entries).toContainEqual(
    expect.objectContaining({ url: "https://egghead.io/workshops/synthetic-workshop" }),
  );
  expect(mocks.references).toHaveBeenCalledOnce();
});
