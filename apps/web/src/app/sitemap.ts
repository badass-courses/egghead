import type { MetadataRoute } from "next";
import { connection } from "next/server";

import { getEggheadSitemapEntries } from "../content/sitemap";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await connection();
  return getEggheadSitemapEntries();
}
