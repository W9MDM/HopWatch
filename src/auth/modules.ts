// Module registry for RBAC. Every page/feature area is a module with a key; access is
// granted per role by module key. Path mapping lets guards resolve a request to a module.

export interface ModuleDef {
  key: string;
  label: string;
  category: "core" | "analysis" | "rf" | "live" | "admin";
  paths: string[]; // page path prefixes
}

// Order here is also the nav order for core modules.
export const MODULES: ModuleDef[] = [
  { key: "dashboard", label: "Dashboard", category: "core", paths: ["/"] },
  { key: "livemap", label: "Live map", category: "live", paths: ["/livemap"] },
  { key: "map", label: "Map", category: "core", paths: ["/map"] },
  { key: "coverage", label: "Coverage", category: "core", paths: ["/coverage"] },
  { key: "history", label: "History", category: "live", paths: ["/history"] },
  { key: "graph", label: "Graph", category: "analysis", paths: ["/graph"] },
  { key: "nodes", label: "Nodes", category: "core", paths: ["/nodes"] },
  { key: "owned", label: "Owned nodes", category: "core", paths: ["/owned-nodes", "/my-reach"] },
  { key: "watchlist", label: "Watchlist", category: "core", paths: ["/watchlist"] },
  { key: "power", label: "Power & battery", category: "core", paths: ["/power", "/battery", "/routers"] },
  { key: "packets", label: "Packets", category: "analysis", paths: ["/packets"] },
  { key: "gateways", label: "Gateways", category: "core", paths: ["/gateways", "/brokers"] },
  { key: "messages", label: "Messages", category: "core", paths: ["/messages"] },
  { key: "matrix", label: "Matrix", category: "analysis", paths: ["/matrix"] },
  { key: "analytics", label: "Analytics", category: "analysis", paths: ["/analytics", "/distributions", "/stats"] },
  { key: "propagation", label: "Propagation", category: "rf", paths: ["/propagation"] },
  { key: "link-budget", label: "Link budget", category: "rf", paths: ["/link-budget", "/los"] },
  { key: "site-planner", label: "Site planner", category: "rf", paths: ["/site-planner"] },
  { key: "records", label: "Records", category: "analysis", paths: ["/records"] },
  { key: "scoreboard", label: "Scoreboard", category: "analysis", paths: ["/scoreboard"] },
  { key: "fleet", label: "Fleet", category: "analysis", paths: ["/fleet"] },
  { key: "traceroutes", label: "Traceroutes", category: "rf", paths: ["/traceroutes"] },
  { key: "backbone", label: "Backbone", category: "rf", paths: ["/backbone"] },
  { key: "new-nodes", label: "New nodes", category: "analysis", paths: ["/new-nodes"] },
  { key: "ghosts", label: "Ghosts", category: "analysis", paths: ["/ghosts"] },
  { key: "flags", label: "Flags & anomalies", category: "analysis", paths: ["/flags"] },
  { key: "spammers", label: "Spammers", category: "analysis", paths: ["/spammers"] },
  { key: "weather", label: "Weather", category: "rf", paths: ["/weather"] },
  { key: "environment", label: "Mesh weather", category: "rf", paths: ["/environment"] },
  { key: "ambience", label: "Ambience", category: "live", paths: ["/ambience"] },
  { key: "kiosk", label: "Kiosk", category: "live", paths: ["/kiosk"] },
  { key: "replay", label: "Replay", category: "live", paths: ["/replay"] },
  { key: "health", label: "Health", category: "core", paths: ["/health"] },
  { key: "api", label: "API docs", category: "analysis", paths: ["/api/v1/openapi.json"] },
  { key: "admin", label: "Admin", category: "admin", paths: ["/admin"] },
];

export const MODULE_KEYS = MODULES.map((m) => m.key);

/** Longest-prefix match of a page/route path to a module key, or null. */
export function moduleForPath(pathname: string): string | null {
  let best: { key: string; len: number } | null = null;
  for (const m of MODULES) {
    for (const p of m.paths) {
      const hit = p === "/" ? pathname === "/" : pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p);
      if (hit && (!best || p.length > best.len)) best = { key: m.key, len: p.length };
    }
  }
  return best?.key ?? null;
}
