"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "../lib/cn.ts";
import { moduleForPath, MODULE_KEYS as MODULE_KEYS_ALL } from "../auth/modules.ts";

interface Item { href: string; label: string; external?: boolean }
interface Group { label: string; href?: string; items?: Item[] }

// One grouped nav (replaces the old top + footer navs).
const GROUPS: Group[] = [
  { label: "Dashboard", href: "/" },
  { label: "Maps", items: [
    { href: "/livemap", label: "Live map" }, { href: "/map", label: "Map" }, { href: "/graph", label: "Graph" },
    { href: "/coverage", label: "Coverage" }, { href: "/history", label: "History" }, { href: "/replay", label: "Replay" },
  ] },
  { label: "Nodes", items: [
    { href: "/nodes", label: "Nodes" }, { href: "/owned-nodes", label: "Owned nodes" }, { href: "/my-reach", label: "My reach" }, { href: "/watchlist", label: "Watchlist" }, { href: "/power", label: "Power & battery" }, { href: "/fleet", label: "Fleet" },
    { href: "/new-nodes", label: "New nodes" }, { href: "/ghosts", label: "Ghosts" },
  ] },
  { label: "Traffic", items: [
    { href: "/packets", label: "Packets" }, { href: "/messages", label: "Messages" }, { href: "/traceroutes", label: "Traceroutes" }, { href: "/backbone", label: "Backbone" },
    { href: "/gateways", label: "Gateways" }, { href: "/brokers", label: "MQTT brokers" }, { href: "/matrix", label: "Matrix" },
  ] },
  { label: "Analytics", items: [
    { href: "/analytics", label: "Analytics" },
    { href: "/records", label: "Records" }, { href: "/scoreboard", label: "Scoreboard" },
    { href: "/weather", label: "Weather" }, { href: "/environment", label: "Mesh weather" },
    { href: "/spammers", label: "Spammers" }, { href: "/flags", label: "Flags & anomalies" },
  ] },
  { label: "Planning", items: [
    { href: "/propagation", label: "Propagation" }, { href: "/link-budget", label: "Link budget" },
    { href: "/los", label: "Line of sight" }, { href: "/site-planner", label: "Site planner" },
  ] },
  { label: "System", items: [
    { href: "/health", label: "Health" }, { href: "/ambience", label: "Ambience" }, { href: "/kiosk", label: "Kiosk" },
    { href: "/admin/settings", label: "Settings" }, { href: "/admin/roles", label: "Roles" }, { href: "/admin/bridge", label: "MQTT bridge" },
    { href: "/api/v1/openapi.json", label: "API", external: true }, { href: "/feeds/events.ics", label: "Calendar", external: true },
  ] },
];

// A nav item is visible when it maps to no module (calendar), or to an allowed one.
// Sign-in lives in the top-right session control, not the nav.
function itemVisible(href: string, allowed: Set<string>): boolean {
  const m = moduleForPath(href);
  return m === null || allowed.has(m);
}

const triggerCls = (active: boolean) =>
  cn("rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors outline-none",
     active ? "bg-raised text-ink" : "text-ink-mute hover:bg-raised hover:text-ink");

export function NavMenu({ allowed = [], admin = false }: { allowed?: string[]; admin?: boolean }) {
  const path = usePathname();
  const isActive = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  const allowSet = new Set(admin ? MODULE_KEYS_ALL : allowed);

  return (
    <nav className="flex flex-nowrap items-center gap-1">
      {GROUPS.map((g) => {
        if (g.href) {
          if (!itemVisible(g.href, allowSet)) return null;
          return (
            <Link key={g.label} href={g.href} className={triggerCls(isActive(g.href))}>
              {g.label}
            </Link>
          );
        }
        const items = g.items!.filter((i) => itemVisible(i.href, allowSet));
        if (items.length === 0) return null;
        const active = items.some((i) => !i.external && isActive(i.href));
        return (
          <DropdownMenu.Root key={g.label}>
            <DropdownMenu.Trigger className={cn(triggerCls(active), "inline-flex items-center gap-1")}>
              {g.label}
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                sideOffset={6}
                align="start"
                className="z-50 min-w-44 rounded-lg border border-line bg-surface p-1 shadow-xl shadow-black/50"
              >
                {items.map((i) => (
                  <DropdownMenu.Item key={i.href} asChild>
                    {i.external ? (
                      <a href={i.href} className="block cursor-pointer rounded-md px-3 py-1.5 text-[13px] text-ink-mute outline-none hover:bg-raised hover:text-ink data-[highlighted]:bg-raised data-[highlighted]:text-ink">
                        {i.label}
                      </a>
                    ) : (
                      <Link href={i.href} className={cn("block cursor-pointer rounded-md px-3 py-1.5 text-[13px] outline-none hover:bg-raised hover:text-ink data-[highlighted]:bg-raised data-[highlighted]:text-ink", isActive(i.href) ? "text-ink" : "text-ink-mute")}>
                        {i.label}
                      </Link>
                    )}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        );
      })}
    </nav>
  );
}
