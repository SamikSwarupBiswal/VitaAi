import type { NextConfig } from "next";

const config: NextConfig = { devIndicators: false,
  async headers() {
    return [{ source: "/teams", headers: [{ key: "Content-Security-Policy", value:
      "frame-ancestors 'self' https://teams.microsoft.com https://*.teams.microsoft.com https://*.cloud.microsoft https://*.office.com" }] }];
  },
};
export default config;
