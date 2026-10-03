import type { NextConfig } from "next";

// Security headers (D69) on every response. Framing is refused, except that /api/files may be framed by our own
// pages (the attachment preview shows a PDF in an iframe). No full CSP yet: it needs testing against react-pdf and
// the charts first (D69); the frame-ancestors directive alone restricts nothing else.
const security = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The camera for photo uploads (S24); nothing else a sign shop's CRM needs.
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=()" },
];

const nextConfig: NextConfig = {
  // lib/pdf.tsx reads the Noto fonts from disk at run time; ship them with every route that renders a PDF
  // (PDF / share routes and the pages whose server actions email one).
  outputFileTracingIncludes: {
    "/share/**": ["./src/assets/fonts/*.ttf"],
    "/quotations/**": ["./src/assets/fonts/*.ttf"],
    "/invoices/**": ["./src/assets/fonts/*.ttf"],
    "/export/**": ["./src/assets/fonts/*.ttf"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [...security, { key: "X-Frame-Options", value: "DENY" }, { key: "Content-Security-Policy", value: "frame-ancestors 'none'" }],
      },
      // Later entries win for the same header (Next docs): our own pages may frame a file.
      {
        source: "/api/files/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
