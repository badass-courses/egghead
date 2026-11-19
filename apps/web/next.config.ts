import type { NextConfig } from "next";

import {
  legacyRedirectsForNextConfig,
  retiredRouteRewritesForNextConfig,
} from "./src/routing/legacy-redirects";

const nextConfig: NextConfig = {
  cacheComponents: true,
  // legacyRedirectsForNextConfig() puts Next's trailing-slash redirect back
  // after one-hop trailing-slash twins of the legacy rules.
  skipTrailingSlashRedirect: true,
  // Legacy egghead.io URL table: src/routing/legacy-redirects.ts.
  // Inventory and contract test: src/routing/route-inventory.ts,
  // test/routing/route-parity.test.ts.
  async redirects() {
    return legacyRedirectsForNextConfig();
  },
  async rewrites() {
    return {
      beforeFiles: retiredRouteRewritesForNextConfig(),
      afterFiles: [],
      fallback: [],
    };
  },
  images: {
    remotePatterns: [
      {
        hostname: "avatars.githubusercontent.com",
        protocol: "https",
      },
      {
        hostname: "d2eip9sf3oo6c2.cloudfront.net",
        protocol: "https",
      },
      {
        hostname: "gravatar.com",
        pathname: "/avatar/**",
        protocol: "https",
      },
      {
        hostname: "res.cloudinary.com",
        protocol: "https",
      },
      {
        hostname: "www.gravatar.com",
        pathname: "/avatar/**",
        protocol: "https",
      },
    ],
  },
  transpilePackages: ["@egghead/ui", "@egghead/workshops", "@egghead/workshop-catalog"],
};

export default nextConfig;
