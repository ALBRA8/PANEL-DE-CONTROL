import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Oculta el indicador flotante de Dev Tools de Next.js (la "N" del DOM)
  devIndicators: false,
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
