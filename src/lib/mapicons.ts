import {
  faTowerBroadcast, faTowerCell, faWifi, faMicrochip, faCircleNodes, type IconDefinition,
} from "@fortawesome/free-solid-svg-icons";

// Node marker rendering shared by the Map and Live map. Nodes are drawn as HTML
// markers (not GeoJSON layers) so they always render and need no glyph server:
// a Font Awesome role icon in a hop-colored ring, with a CSS-halo name label.

export const ROLE_COLORS: Record<string, string> = {
  CLIENT: "#a4a39c", CLIENT_MUTE: "#6f6e67", ROUTER: "#3f9e63", ROUTER_CLIENT: "#5bb37e", REPEATER: "#e0b43a",
};
export const roleColor = (r: string | null): string => ROLE_COLORS[(r ?? "").toUpperCase()] ?? "#a4a39c";

// Meshtastic hop_limit maxes at 7, so the scale runs 0 (direct) .. 7+.
export const HOP_SCALE = ["#3f9e63", "#5bb37e", "#8ab84f", "#e0b43a", "#e8962f", "#e8792f", "#f0562f", "#f04747"];
export function hopColor(hops: number | null | undefined): string {
  if (hops === null || hops === undefined || hops < 0) return "#6f6e67";
  return HOP_SCALE[Math.min(hops, 7)]!;
}

// Estimated (non-GPS) nodes are drawn in a distinct violet so they are never mistaken
// for a real position. Confidence circles use the translucent variants.
export const EST_COLOR = "#b98cff";
export const EST_COLOR_LIGHT = "#7c3aed";
export const estColor = (dark: boolean): string => (dark ? EST_COLOR : EST_COLOR_LIGHT);

// Node-type filter for the maps (dropdown). "client" catches CLIENT/CLIENT_MUTE and any
// unlabelled non-infra node; gateways are matched by the is_gateway flag regardless of role.
export const NODE_TYPES: { key: string; label: string }[] = [
  { key: "all", label: "all types" },
  { key: "client", label: "clients" },
  { key: "router", label: "routers" },
  { key: "repeater", label: "repeaters" },
  { key: "gateway", label: "gateways" },
];
export function matchesNodeType(role: string | null, isGateway: boolean, type: string): boolean {
  if (type === "all") return true;
  if (type === "gateway") return isGateway;
  const r = (role ?? "").toUpperCase();
  if (type === "repeater") return r === "REPEATER";
  if (type === "router") return r === "ROUTER" || r === "ROUTER_CLIENT";
  if (type === "client") return r === "CLIENT" || r === "CLIENT_MUTE" || (!isGateway && r !== "REPEATER" && r !== "ROUTER" && r !== "ROUTER_CLIENT");
  return true;
}
export function hopLabel(hops: number | null | undefined): string {
  if (hops === null || hops === undefined || hops < 0) return "";
  return hops >= 7 ? "7+" : String(hops);
}

function iconFor(role: string | null, isGateway: boolean): IconDefinition {
  if (isGateway) return faTowerBroadcast;
  switch ((role ?? "").toUpperCase()) {
    case "REPEATER": return faTowerCell;
    case "ROUTER":
    case "ROUTER_CLIENT": return faWifi;
    case "CLIENT":
    case "CLIENT_MUTE": return faMicrochip;
    default: return faCircleNodes;
  }
}

export function iconSvg(role: string | null, isGateway: boolean, color: string, px: number): string {
  const def = iconFor(role, isGateway);
  const [w, h, , , path] = def.icon;
  const d = Array.isArray(path) ? path.join("") : path;
  return `<svg width="${px}" height="${px}" viewBox="0 0 ${w} ${h}" fill="${color}" aria-hidden="true"><path d="${d}"/></svg>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));
}

export interface NodeMarkerOpts {
  name: string;
  role: string | null;
  isGateway: boolean;
  hops?: number | null;
  showLabel?: boolean;
  dark?: boolean; // basemap mode: controls dot background + label color/halo
  estimated?: boolean; // non-GPS: draw hollow/dashed in the estimate color
}

// Build the marker DOM element. Caller wires click/hover and adds it via maplibregl.Marker.
export function buildNodeElement(opts: NodeMarkerOpts): HTMLDivElement {
  const size = opts.isGateway ? 30 : 24;
  const dark = opts.dark !== false;
  const estimated = opts.estimated === true;
  const ring = estimated ? estColor(dark) : hopColor(opts.hops);
  const badge = estimated ? "~" : hopLabel(opts.hops);
  const dotBg = estimated ? "transparent" : dark ? "#141412" : "#ffffff";
  const iconColor = estimated ? estColor(dark) : roleColor(opts.role);
  const border = estimated ? `3px dashed ${ring}` : `3px solid ${ring}`;
  const labelColor = estimated ? estColor(dark) : dark ? "#f2f1ed" : "#0b0b0a";
  const halo = dark ? "0 0 3px #000,0 0 4px #000,0 0 5px #000" : "0 0 3px #fff,0 0 4px #fff,0 0 5px #fff";
  const el = document.createElement("div");
  el.style.cursor = "pointer";
  el.innerHTML = `
    <div style="position:relative;width:${size}px;height:${size}px">
      <div style="width:${size}px;height:${size}px;border-radius:50%;background:${dotBg};border:${border};
                  display:grid;place-items:center;box-shadow:0 1px 4px rgba(0,0,0,.7);${estimated ? "opacity:.92" : ""}">
        ${iconSvg(opts.role, opts.isGateway, iconColor, Math.round(size * 0.52))}
      </div>
      ${badge ? `<div style="position:absolute;top:-5px;right:-5px;background:${ring};color:#0b0b0a;
                  font:700 9px 'Segoe UI',system-ui;border-radius:8px;min-width:14px;height:14px;
                  text-align:center;line-height:14px;padding:0 2px">${badge}</div>` : ""}
      ${opts.showLabel === false ? "" : `<div style="position:absolute;top:${size + 1}px;left:50%;transform:translateX(-50%);
                  font:700 11px 'Segoe UI',system-ui;color:${labelColor};white-space:nowrap;pointer-events:none;
                  text-shadow:${halo}">${escapeHtml(opts.name)}</div>`}
    </div>`;
  return el;
}

// Fallback dark basemap, used only when the configured dark provider is unavailable. Both the
// light and dark providers are set in /admin/settings (see src/lib/maptiles.ts); these constants
// are the last-resort default so a map still renders during a settings hiccup. CARTO now requires a
// free API key on its raster tiles (?key=YOUR_KEY), so a fresh install should paste a keyed URL.
export const DARK_TILES = "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png";
export const DARK_ATTRIB = "© OpenStreetMap © CARTO";
