import Link from "next/link";
import { effectiveConfig } from "../../db/appsettings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Privacy & data use" };

// Public privacy / data-use / terms notice (no module gate). Addresses the audit's legal and
// privacy-notice gaps. Content reflects how the observatory actually behaves in code.
export default async function PrivacyPage() {
  let brand = "HopWatch";
  let links = { website: "", discord: "", facebook: "" };
  let fuzzed = false;
  try {
    const cfg = await effectiveConfig();
    brand = cfg.server.ui.brand_name || "HopWatch";
    links = cfg.server.ui.social_links;
    fuzzed = cfg.server.privacy.fuzz_positions;
  } catch { /* defaults */ }
  const contact = links.discord || links.website || links.facebook;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="eyebrow"><span className="eyebrow-bar" />Privacy &amp; data use</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-mute">
          {brand} displays data that Meshtastic radios broadcast over an open network. This page explains what is
          shown and how to limit it. It is a plain-language notice, not a contract.
        </p>
      </div>

      <section className="card space-y-2">
        <h2 className="eyebrow"><span className="eyebrow-bar" />What is shown</h2>
        <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-ink-mute">
          <li>Node names, hardware, and roles as each node reports them.</li>
          <li>Signal quality (RSSI/SNR), hop counts, and which gateways heard each node.</li>
          <li>Positions that nodes self-report over the mesh, and estimated positions inferred from reception.</li>
          <li>Text messages sent on channels this site has the key for. Direct messages between other nodes are never forwarded off-site.</li>
        </ul>
      </section>

      <section className="card space-y-2">
        <h2 className="eyebrow"><span className="eyebrow-bar" />Location privacy</h2>
        <p className="text-[13px] leading-relaxed text-ink-mute">
          Positions come from each node&apos;s own GPS or configuration. If you do not want your precise location
          shown, do not broadcast a precise position from your node (Meshtastic lets you disable or coarsen GPS
          sharing per device). {fuzzed
            ? "On this site, public coordinates are currently rounded to protect residential locations."
            : "This site can also round public coordinates for privacy when the operator enables it."}
          {" "}A node marked position-ignored or muted by an operator is removed from the maps entirely.
        </p>
      </section>

      <section className="card space-y-2">
        <h2 className="eyebrow"><span className="eyebrow-bar" />Accuracy &amp; use</h2>
        <p className="text-[13px] leading-relaxed text-ink-mute">
          This is unofficial, best-effort community data and may be delayed, wrong, or spoofed.
          <strong className="text-ink"> Do not rely on it for emergencies or life-safety decisions.</strong> For
          emergencies, call 911. See <Link href="/about" className="text-accent hover:underline">About</Link> for scope.
        </p>
      </section>

      <section className="card space-y-2">
        <h2 className="eyebrow"><span className="eyebrow-bar" />Opt out / corrections</h2>
        <p className="text-[13px] leading-relaxed text-ink-mute">
          To have a node hidden or a listing corrected, contact the operators through the community channels.
          Requests are handled on a best-effort basis.
        </p>
        {contact && (
          <a href={contact} target="_blank" rel="noopener noreferrer" className="btn btn-outline h-8 w-fit px-3 text-[13px]">Contact the operators</a>
        )}
      </section>
    </div>
  );
}
