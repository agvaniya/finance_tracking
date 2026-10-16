import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Everything is per-request data from the local database; component caching
  // off keeps pages straightforwardly dynamic.
  output: "standalone",
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
