import "./globals.css";
import type { ReactNode } from "react";
import Link from "next/link";
import { cookies } from "next/headers";
import { versionInfo } from "../lib/version.ts";
import { effectiveConfig } from "../db/appsettings.ts";
import { verifySession, SESSION_COOKIE } from "../auth/session.ts";
import { pageAccess } from "../auth/rbac.ts";
import { getHealthSnapshot, getNodeRxHealth } from "../db/queries.ts";
import { RfNodeChip } from "../components/RfNodeChip.tsx";
import { ViewersChip } from "../components/ViewersChip.tsx";
import { networkCondition, conditionTextClass } from "../lib/condition.ts";
import { SessionControls } from "../components/SessionControls.tsx";
import { CommandPalette } from "../components/CommandPalette.tsx";
import { NavMenu } from "../components/NavMenu.tsx";
import { SocialLinks, type SocialLinksConfig } from "../components/SocialLinks.tsx";
import { TableSortEnhancer } from "../components/TableSortEnhancer.tsx";
import { TableToolsEnhancer } from "../components/TableToolsEnhancer.tsx";
import { RowLinkEnhancer } from "../components/RowLinkEnhancer.tsx";
import { KioskChrome } from "../components/KioskChrome.tsx";
import { Analytics } from "../components/Analytics.tsx";
import type { Metadata, Viewport } from "next";

// Theme color drives the mobile browser chrome + PWA splash. Dark by default (HopWatch is
// dark-first); light value applies when the OS prefers light.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0a" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
};

// Metadata is DB-driven (brand name + canonical public URL) so a rebrand needs no code change.
// A per-page <title> template gives every route an honest, shareable title; OpenGraph/Twitter
// cards make shared links render a real preview (the opengraph-image route supplies the image).
export async function generateMetadata(): Promise<Metadata> {
  let brand = "HopWatch";
  let publicUrl = "";
  try {
    const ui = (await effectiveConfig()).server;
    brand = ui.ui.brand_name || "HopWatch";
    publicUrl = ui.public_url || "";
  } catch { /* defaults */ }
  const description = `Live map and telemetry for the ${brand} Meshtastic/LoRa mesh: nodes, RF coverage, hop counts, and packet activity.`;
  return {
    ...(publicUrl ? { metadataBase: new URL(publicUrl) } : {}),
    title: { default: brand, template: `%s · ${brand}` },
    description,
    applicationName: brand,
    manifest: "/manifest.webmanifest",
    appleWebApp: { capable: true, title: brand, statusBarStyle: "black-translucent" },
    openGraph: {
      type: "website",
      siteName: brand,
      title: brand,
      description,
      ...(publicUrl ? { url: publicUrl } : {}),
    },
    twitter: { card: "summary_large_image", title: brand, description },
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const v = versionInfo();
  // Brand name + icon are DB-backed (admin UI) and hot-reload via effectiveConfig().
  let brand = "HopWatch";
  let brandIcon = "";
  let gaId = ""; // GA4 measurement id for client gtag, only when enabled + client tracking on
  let social: SocialLinksConfig = { facebook: "", discord: "", website: "" };
  let nodeCfg = { host: "", rx_enabled: false };
  try {
    const cfg = await effectiveConfig();
    const ui = cfg.server.ui;
    brand = ui.brand_name || "HopWatch";
    brandIcon = ui.brand_icon || "";
    social = ui.social_links;
    nodeCfg = { host: cfg.node.host, rx_enabled: cfg.node.rx_enabled };
    if (ui.analytics.enabled && ui.analytics.client && ui.analytics.measurement_id) gaId = ui.analytics.measurement_id;
  } catch {
    /* default brand retained if settings are unavailable */
  }
  const jar = await cookies();
  const session = verifySession(jar.get(SESSION_COOKIE)?.value);
  // Both from the same resolved access: the cookie's baked-in role string is up to 30 days stale, so
  // a demoted admin kept the admin nav and command palette, and a CUSTOM admin role never got them
  // at all (the literal `role === "admin"` comparison this replaces could not see one).
  let isAdmin = false;
  let allowedModules: string[] = [];
  try {
    const access = await pageAccess();
    isAdmin = access.admin;
    allowedModules = [...access.modules];
  } catch {
    /* nav stays minimal if settings are unavailable; every admin route still guards itself */
  }
  // Always-visible network condition badge (derived from the mesh health score).
  let cond = networkCondition(null, null);
  let condScore: number | null = null;
  try {
    const snap = await getHealthSnapshot();
    condScore = snap?.score ?? null;
    const ageMin = snap?.computed_at ? (Date.now() - new Date(snap.computed_at.replace(" ", "T") + "Z").getTime()) / 60000 : null;
    cond = networkCondition(condScore, ageMin);
  } catch {
    /* badge shows Unknown if the snapshot cannot be read */
  }
  // RF station-node connection state (null when RX is disabled -> chip hidden).
  let nodeRx: { connected: number; last_message_at: string | null; messages: number } | null = null;
  try { nodeRx = await getNodeRxHealth(); } catch { /* chip hidden if unreadable */ }
  return (
    <html lang="en">
      <body>
        {gaId && <Analytics measurementId={gaId} />}
        <KioskChrome />
        <div className="mx-auto flex min-h-screen max-w-[1800px] flex-col px-4 lg:px-6">
          {/* Single-row header: brand and controls are fixed; the nav takes the middle and
              scrolls horizontally if it ever overflows, so it never wraps to a second line
              regardless of how many groups the role can see. */}
          <header className="flex items-center gap-3 border-b border-line py-3">
            <Link href="/" className="flex min-w-0 shrink items-center gap-2">
              {brandIcon
                ? <img src={brandIcon} alt="" className="block h-6 w-6 flex-none rounded object-contain" />
                : <span className="block h-4 w-1 flex-none bg-accent" />}
              <span className="truncate text-base font-semibold tracking-wide text-ink">{brand}</span>
            </Link>
            <div className="min-w-0 flex-1 overflow-x-auto">
              <NavMenu allowed={allowedModules} admin={isAdmin} />
            </div>
            <div className="flex flex-none items-center gap-2 sm:gap-3">
              {/* Secondary status chips are hidden on small screens so the header fits on one line;
                  the mesh condition also lives on /health, and search + the account menu stay. */}
              <div className="hidden items-center gap-3 md:flex">
                <Link
                  href="/health"
                  className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[12px] hover:bg-raised"
                  title={condScore == null ? "Network condition (no recent health score)" : `Network condition (mesh health ${condScore}/100)`}
                >
                  <span className={`inline-block h-2 w-2 rounded-full ${conditionTextClass(cond.tone)}`} style={{ background: "currentColor" }} />
                  <span className="hidden text-ink-faint lg:inline">Mesh:</span>
                  <span className={`font-medium ${conditionTextClass(cond.tone)}`}>{cond.label}</span>
                </Link>
                {nodeCfg.host && (
                  <RfNodeChip initial={{ host: nodeCfg.host, rx_enabled: nodeCfg.rx_enabled, connected: nodeRx?.connected ? 1 : 0, last_message_at: nodeRx?.last_message_at ?? null }} />
                )}
                <ViewersChip />
                <SocialLinks links={social} />
              </div>
              <CommandPalette allowed={allowedModules} admin={isAdmin} />
              <SessionControls admin={isAdmin} user={session?.sub ?? null} build={`v${v.version} · ${v.commit}`} />
            </div>
          </header>

          <main className="flex-1 py-6">{children}</main>
          <TableSortEnhancer />
          <TableToolsEnhancer />
          <RowLinkEnhancer />

          <footer className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line py-3 text-[11px] text-ink-faint">
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>{brand}</span>
              <Link href="/about" className="hover:text-ink">About</Link>
              <Link href="/help" className="hover:text-ink">Help</Link>
              <Link href="/privacy" className="hover:text-ink">Privacy</Link>
              <span className="text-ink-faint/70">Unofficial community data, not for life-safety dispatch.</span>
            </span>
            <span className="mono">
              v{v.version} · {v.commit.slice(0, 8)}
            </span>
          </footer>
        </div>
      </body>
    </html>
  );
}
