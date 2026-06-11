import type { MetadataRoute } from "next";

import { getEggheadSitemapEntries } from "../content/sitemap";

export default function sitemap(): Promise<MetadataRoute.Sitemap> {
  return getEggheadSitemapEntries();
}
