import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // lib/pdf.tsx reads the Noto fonts from disk at run time; ship them with every route that renders a PDF
  // (PDF / share routes and the pages whose server actions email one).
  outputFileTracingIncludes: {
    "/share/**": ["./src/assets/fonts/*.ttf"],
    "/quotations/**": ["./src/assets/fonts/*.ttf"],
    "/invoices/**": ["./src/assets/fonts/*.ttf"],
  },
};

export default nextConfig;
