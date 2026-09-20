import { ImageResponse } from "next/og";
import { effectiveConfig } from "../db/appsettings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // reflect a DB rebrand rather than baking the build-time name
export const alt = "HopWatch mesh network observatory";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Social-share preview card. Brand name is DB-driven; the art is a hop-ring motif matching the
// app icon and map legend. Self-contained (no external fonts/images, per the CSP).
export default async function OgImage() {
  let brand = "HopWatch";
  try {
    brand = (await effectiveConfig()).server.ui.brand_name || "HopWatch";
  } catch { /* default */ }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          background: "#0b0b0a",
          color: "#f2f1ed",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "28px" }}>
          <svg width="120" height="120" viewBox="0 0 64 64">
            <circle cx="32" cy="32" r="26" fill="none" stroke="#3f9e63" strokeWidth="3" opacity="0.45" />
            <circle cx="32" cy="32" r="16" fill="none" stroke="#5bb37e" strokeWidth="3" opacity="0.7" />
            <circle cx="32" cy="32" r="7" fill="#e0b43a" />
          </svg>
          <div style={{ fontSize: 96, fontWeight: 700 }}>{brand}</div>
        </div>
        <div style={{ marginTop: 32, fontSize: 40, color: "#a3a29c", maxWidth: 900 }}>
          Live map and telemetry for the Meshtastic / LoRa mesh: nodes, RF coverage, hop counts, and packet activity.
        </div>
      </div>
    ),
    size,
  );
}
