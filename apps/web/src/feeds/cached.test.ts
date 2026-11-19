import { existsSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const cacheTag = vi.fn();
const cacheLife = vi.fn();
vi.mock("next/cache", () => ({ cacheTag, cacheLife }));

const source = vi.fn(async (_slug: string) => null);
vi.mock("./instructor-podcast-source", () => ({ typesenseInstructorPodcastSource: source }));

describe("/i/:slug/rss.xml cache boundary (judge #15)", () => {
  beforeEach(() => {
    cacheTag.mockClear();
    cacheLife.mockClear();
    source.mockClear();
  });

  it("rejects bad slugs before any cache tag or Typesense call", async () => {
    const { instructorPodcastXml } = await import("./cached");
    const results = await Promise.all(
      ["Ada", "x".repeat(500), "ada&&x:=y", "ada/../x", ""].map((slug) =>
        instructorPodcastXml(slug),
      ),
    );
    expect(results).toEqual([null, null, null, null, null]);
    expect(cacheTag).not.toHaveBeenCalled();
    expect(cacheLife).not.toHaveBeenCalled();
    expect(source).not.toHaveBeenCalled();
  });

  it("tags, queries and caches misses briefly for a slug-shaped id", async () => {
    const { instructorPodcastXml } = await import("./cached");
    await expect(instructorPodcastXml("ada-fixture")).resolves.toBeNull();
    expect(source).toHaveBeenCalledWith("ada-fixture");
    expect(cacheTag).toHaveBeenCalledWith("egghead-feed:instructor-podcast:ada-fixture");
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });
});

describe("feed channel image (judge #25)", () => {
  it("points at an image this app serves from public/", async () => {
    const { PRO_FEED_IMAGE_URL, RAILS_FEED_HOST } = await import("./rails-parity");
    expect(PRO_FEED_IMAGE_URL.startsWith(`${RAILS_FEED_HOST}/`)).toBe(true);
    const path = PRO_FEED_IMAGE_URL.slice(RAILS_FEED_HOST.length);
    expect(existsSync(join(import.meta.dirname, "../../public", path))).toBe(true);
  });
});
