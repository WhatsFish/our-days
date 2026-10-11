/** @type {import('next').NextConfig} */
const config = {
  output: "standalone",
  basePath: "/our-days",
  poweredByHeader: false,
  serverExternalPackages: ["sharp", "exiftool-vendored", "pg", "yauzl"],
  experimental: {
    cpus: 1,
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        { key: "Cache-Control", value: "private, no-store" },
      ],
    }];
  },
};
export default config;
