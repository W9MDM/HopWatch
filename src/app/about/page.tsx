import Link from "next/link";
import { effectiveConfig } from "../../db/appsettings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "About" };

// Public info page (no module gate): what this site is, who runs it, and how honest the data is.
// Answers the auditor's "who runs this / what is the data" authority gap and the 5-second test.
export default async function AboutPage() {
  let brand = "HopWatch";
  let links = { website: "", discord: "", facebook: "" };
  try {
    const cfg = await effectiveConfig();
    brand = cfg.server.ui.brand_name || "HopWatch";
    links = cfg.server.ui.social_links;
  } catch { /* defaults */ }
  const anyLink = links.website || links.discord || links.facebook;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="eyebrow"><span className="eyebrow-bar" />About {brand}</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-ink">
          {brand} is a live map of a volunteer <strong>Meshtastic / LoRa mesh radio network</strong>. Each dot is a
          low-power radio device relaying text and telemetry off-grid, without cell towers or the internet. This
          site listens to what those devices report and shows the network's health: who is on the air, how far
          their signal reaches, and how many hops it takes messages to travel.
        </p>
      </div>

      <section className="card space-y-2">
        <h2 className="eyebrow"><span className="eyebrow-bar" />What you are looking at</h2>
        <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-ink-mute">
          <li><strong className="text-ink">Nodes</strong> are individual radios. Color and rings show how many hops away each was heard.</li>
          <li><strong className="text-ink">Gateways</strong> are nodes that also bridge the mesh to the internet (MQTT), which is how this site sees the traffic.</li>
          <li><strong className="text-ink">Coverage</strong> shows which nodes are heard directly by a gateway versus relayed through others.</li>
          <li>Positions come from what each node reports. Some are <strong className="text-ink">estimated</strong> (dashed, with a confidence circle) rather than GPS.</li>
        </ul>
        <p className="text-[12px] text-ink-faint">New to the glossary (SNR, RSSI, hop, reception)? See <Link href="/help" className="text-accent hover:underline">Help</Link>.</p>
      </section>

      <section className="card space-y-2">
        <h2 className="eyebrow"><span className="eyebrow-bar" />How trustworthy is this</h2>
        <p className="text-[13px] leading-relaxed text-ink-mute">
          This is a passive observatory: it listens and does not control any node. The data is <strong className="text-ink">best-effort
          community data</strong>, self-reported by radios over an open network, and can be delayed, incomplete, or
          spoofed. <strong className="text-ink">It is not an official system and must not be relied on for life-safety
          dispatch or emergencies.</strong> For emergencies, call 911.
        </p>
      </section>

      <section className="card space-y-2">
        <h2 className="eyebrow"><span className="eyebrow-bar" />Get involved</h2>
        <p className="text-[13px] leading-relaxed text-ink-mute">
          The mesh grows when people add nodes. If you want to build one, extend coverage, or just say hello,
          reach the community through the links below.
        </p>
        {anyLink ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {links.website && <a href={links.website} target="_blank" rel="noopener noreferrer" className="btn btn-outline h-8 px-3 text-[13px]">Website</a>}
            {links.discord && <a href={links.discord} target="_blank" rel="noopener noreferrer" className="btn btn-outline h-8 px-3 text-[13px]">Discord</a>}
            {links.facebook && <a href={links.facebook} target="_blank" rel="noopener noreferrer" className="btn btn-outline h-8 px-3 text-[13px]">Facebook</a>}
          </div>
        ) : (
          <p className="text-[12px] text-ink-faint">Community links can be set by an admin in Settings.</p>
        )}
      </section>
    </div>
  );
}
