/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV !== "production";

const nextConfig = {
  // In dev, skip static export so API rewrites work against twilio-run.
  ...(isDev
    ? {}
    : {
        output: "export",
        distDir: "out",
        trailingSlash: true,
      }),
  images: { unoptimized: true },
  async rewrites() {
    if (!isDev) return [];
    const target = process.env.FUNCTIONS_ORIGIN || "http://localhost:3333";
    return [
      { source: "/send", destination: `${target}/send` },
      { source: "/templates", destination: `${target}/templates` },
      { source: "/sync-token", destination: `${target}/sync-token` },
      { source: "/status-callback", destination: `${target}/status-callback` },
      { source: "/events-sink", destination: `${target}/events-sink` },
      { source: "/incoming-sms", destination: `${target}/incoming-sms` },
      { source: "/admin-:path", destination: `${target}/admin-:path` },
      { source: "/approved-:path", destination: `${target}/approved-:path` },
      { source: "/verify-:path", destination: `${target}/verify-:path` },
      { source: "/senders-approved", destination: `${target}/senders-approved` },
      { source: "/senders-approved-set", destination: `${target}/senders-approved-set` },
    ];
  },
};

export default nextConfig;
