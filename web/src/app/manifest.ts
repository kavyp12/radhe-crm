import type { MetadataRoute } from "next";

// T42 PWA (D26, D67): installs Radhe CRM on a phone. No service worker — Chrome's install criteria don't need one,
// and live accounting data must never be served from a cache. Placeholder "R" icons until the logo arrives (Q3).
// Theme colour = --primary (indigo-600) in globals.css.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Radhe CRM",
    short_name: "Radhe CRM",
    description: "CRM, accounts and print jobs for Radhe Digital Sign Board",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#fafafa",
    theme_color: "#4f46e5",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
