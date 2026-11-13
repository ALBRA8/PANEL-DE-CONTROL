import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Raíz del workspace Turbopack FIJADA al proyecto: sin esto, cuando el
  // checkout del PANEL va anidado dentro de otro repo (CI del MSI), Next
  // infiere la raíz por el lockfile exterior y escribe .next fuera de aquí.
  turbopack: {
    root: __dirname,
  },
  // Oculta el indicador flotante de Dev Tools de Next.js (la "N" del DOM)
  devIndicators: false,
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
