/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Ingest/worker are separate processes; the Next app is read-mostly.
  // Expose build metadata to the footer and /api/version.
  env: {
    HOPWATCH_GIT_COMMIT: process.env.HOPWATCH_GIT_COMMIT ?? "dev",
  },
  serverExternalPackages: ["mysql2", "kysely"],
  // Security response headers (defense in depth). The CSP is deliberately shaped for this
  // app: MapLibre GL creates web workers from blob: URLs, loads raster tiles as images from
  // configurable https hosts, and Next injects inline bootstrap scripts (hence
  // 'unsafe-inline' for script/style until a nonce pipeline is added). Everything else is
  // locked to same-origin, including framing (frame-ancestors 'self' + X-Frame-Options).
  async headers() {
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'self'",
      "form-action 'self'",
      "img-src 'self' data: blob: https:",
      "style-src 'self' 'unsafe-inline'",
      // googletagmanager is allowed so optional Google Analytics (gtag.js) can load when an
      // admin enables it; cloudflareinsights is Cloudflare Web Analytics' beacon (injected by
      // the CF zone). Its telemetry POSTs are covered by the https: connect rule; Zaraz runs
      // from the same-origin /cdn-cgi/ path and needs no extra allowance.
      "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://static.cloudflareinsights.com",
      "worker-src 'self' blob:",
      "connect-src 'self' https:",
      "font-src 'self' data:",
    ].join("; ");
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
        ],
      },
    ];
  },
};

export default nextConfig;
