/** @type {import('next').NextConfig} */

// The Bun API server. The browser never talks to it directly — Next.js proxies
// every /api/* request to it server-side, so requests stay same-origin and CORS
// never comes into play. Override SERVER_ORIGIN if the API runs on another host.
const serverOrigin = (process.env.SERVER_ORIGIN ?? "http://localhost:8787").replace(
  /\/$/,
  "",
);

const nextConfig = {
  transpilePackages: ["@repo/ai-config"],
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${serverOrigin}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
