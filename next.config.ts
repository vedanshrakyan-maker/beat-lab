import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pg-boss and Prisma must stay server-side Node modules.
  serverExternalPackages: ["pg-boss", "@prisma/client"],
  poweredByHeader: false,
};

export default nextConfig;
