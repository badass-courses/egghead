import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  experimental: {
    isolatedDevBuild: false,
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
  transpilePackages: ["@egghead/ui"],
};

export default nextConfig;
