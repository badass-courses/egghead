import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  experimental: {
    isolatedDevBuild: false,
  },
  images: {
    remotePatterns: [
      {
        hostname: "www.gravatar.com",
        pathname: "/avatar/**",
        protocol: "https",
      },
    ],
  },
  transpilePackages: ["@egghead/ui"],
};

export default nextConfig;
