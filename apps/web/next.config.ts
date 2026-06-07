import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  experimental: {
    isolatedDevBuild: false,
  },
  transpilePackages: ["@egghead/ui"],
};

export default nextConfig;
