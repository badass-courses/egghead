import type { MetadataRoute } from "next";

import { robotsPolicy } from "../content/sitemap";

export default function robots(): MetadataRoute.Robots {
  return robotsPolicy();
}
