import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connection: vi.fn(async (): Promise<void> => undefined),
  entries: vi.fn(async () => [{ url: "https://egghead.io/synthetic-course" }]),
}));

vi.mock("next/server", () => ({ connection: mocks.connection }));
vi.mock("../../src/content/sitemap", () => ({ getEggheadSitemapEntries: mocks.entries }));

import sitemap from "../../src/app/sitemap";

afterEach(() => vi.clearAllMocks());

it("waits for a request before generating the cached sitemap", async () => {
  let acceptRequest: () => void = vi.fn();
  const request = new Promise<void>((resolve) => {
    acceptRequest = resolve;
  });
  mocks.connection.mockReturnValueOnce(request);
  const result = sitemap();
  expect(mocks.entries).not.toHaveBeenCalled();
  acceptRequest();
  await expect(result).resolves.toEqual([{ url: "https://egghead.io/synthetic-course" }]);
  expect(mocks.entries).toHaveBeenCalledOnce();
});
