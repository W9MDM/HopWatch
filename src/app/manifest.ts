import type { MetadataRoute } from "next";
import { effectiveConfig } from "../db/appsettings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PWA manifest so the observatory is installable (add-to-homescreen, standalone display) for
// field/EOC use. Brand name is DB-driven; the icon is the app's SVG (icon.svg), which modern
// installers accept. Dark-first theme to match the UI.
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  let brand = "HopWatch";
  try {
    brand = (await effectiveConfig()).server.ui.brand_name || "HopWatch";
  } catch { /* default */ }
  return {
    name: `${brand} - Mesh Observatory`,
    short_name: brand,
    description: `Live map and telemetry for the ${brand} Meshtastic/LoRa mesh.`,
    start_url: "/",
    display: "standalone",
    background_color: "#0b0b0a",
    theme_color: "#0b0b0a",
    orientation: "any",
    icons: [
      { src: "/icon.svg", type: "image/svg+xml", sizes: "any", purpose: "any" },
      { src: "/icon.svg", type: "image/svg+xml", sizes: "any", purpose: "maskable" },
    ],
  };
}
