import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    isolatedDevBuild: false,
  },
  transpilePackages: ["@egghead/ui"],
};

export default nextConfig;
