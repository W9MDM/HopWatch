import { effectiveConfig } from "../db/appsettings.ts";

// The basemap URLs the map components need, resolved from settings once per page render.
//
// SERVER ONLY: this reaches effectiveConfig (the DB). The client-safe fallbacks (DARK_TILES,
// DARK_ATTRIB) live in mapicons.ts so map components can import them without pulling the DB in.
//
// Both the light and dark providers are operator-configurable in /admin/settings. Dark was a
// hardcoded CARTO constant until CARTO started requiring an API key on its raster tiles; it is now a
// pasteable URL template like light, so the operator drops in their keyed CARTO URL (or any other
// dark provider) rather than editing code.

/** Both basemaps for the dark/light toggle, plus attributions. `dark*` feed the dark toggle. */
export interface MapTiles {
  url: string;
  attribution: string;
  darkUrl: string;
  darkAttribution: string;
}

const OSM = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTRIB = "© OpenStreetMap contributors";
const CARTO_DARK = "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png";
const CARTO_DARK_ATTRIB = "© OpenStreetMap © CARTO";

/**
 * Resolve both basemaps from settings. Falls back to keyless OSM (light) and CARTO (dark) when the
 * config cannot be read, so a map still renders during a settings/DB hiccup.
 */
export async function mapTiles(): Promise<MapTiles> {
  try {
    const ui = (await effectiveConfig()).server.ui;
    return {
      url: ui.tile_provider.url_template,
      attribution: ui.tile_provider.attribution,
      darkUrl: ui.tile_provider_dark.url_template,
      darkAttribution: ui.tile_provider_dark.attribution,
    };
  } catch {
    return { url: OSM, attribution: OSM_ATTRIB, darkUrl: CARTO_DARK, darkAttribution: CARTO_DARK_ATTRIB };
  }
}
