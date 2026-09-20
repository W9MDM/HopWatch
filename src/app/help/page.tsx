import Link from "next/link";
import { effectiveConfig } from "../../db/appsettings.ts";
import { buildChannelSetUrl } from "../../meshtastic/channelurl.ts";
import { qrSvg } from "../../lib/qr.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Help" };

// Public glossary + FAQ + troubleshooting (no module gate). Addresses the audit's jargon,
// onboarding, and self-service-docs gaps.
const GLOSSARY: { term: string; def: string }[] = [
  { term: "Node", def: "A single Meshtastic radio (usually an ESP32 or nRF52 board). Every dot on the map is a node." },
  { term: "Gateway", def: "A node that also relays the mesh to the internet over MQTT. Gateways are how this site sees traffic; a node only appears here once a gateway has heard it." },
  { term: "Reception", def: "One gateway hearing one packet. The same message heard by three gateways is three receptions of one packet. Coverage and signal stats are built from receptions, not raw packets." },
  { term: "Hop", def: "One relay step. 0 hops (direct) means a gateway heard the node's own transmission over the air; 2 hops means two nodes relayed it along the way." },
  { term: "Direct vs relayed", def: "Direct = heard over the air with no relay (green). Relayed = reached the gateway through one or more other nodes (yellow). Only direct receptions tell you about a node's real range." },
  { term: "RSSI", def: "Received Signal Strength, in dBm. Closer to 0 is stronger; -60 is a strong signal, -120 is barely heard." },
  { term: "SNR", def: "Signal-to-Noise Ratio, in dB. Higher is cleaner. LoRa can still decode well below 0 dB SNR." },
  { term: "Estimated position", def: "A node with no GPS whose location is inferred from which gateways heard it. Drawn as a dashed marker with a confidence circle; it is a guess, not a fix." },
  { term: "Channel", def: "A named, usually-encrypted group that nodes talk on (e.g. LongFast). This site can only read channels it has been given the key for." },
];

const FAQ: { q: string; a: string }[] = [
  { q: "Why is my node not on the map?", a: "It only shows up once a gateway hears it AND it has reported a position (or enough gateways heard it to estimate one). If it has no GPS and only one gateway hears it, there is not enough information to place it." },
  { q: "Why does my node show as more hops than I expect?", a: "Hop count is the fewest hops any gateway used to hear you in the last 24h. If your nearest gateway is several relays away, that is your hop distance from the internet-connected part of the mesh, not a fault." },
  { q: "Is the data live?", a: "The live map animates receptions in real time. Other pages refresh on load or on a short timer. Everything is best-effort: gaps happen when gateways drop offline." },
  { q: "Can I trust the positions exactly?", a: "No. Positions are self-reported and may be rounded for privacy. Estimated (dashed) positions are inferred and can be off by a wide margin." },
];

export default async function HelpPage() {
  let brand = "HopWatch";
  let links = { website: "", discord: "", facebook: "" };
  try {
    const cfg = await effectiveConfig();
    brand = cfg.server.ui.brand_name || "HopWatch";
    links = cfg.server.ui.social_links;
  } catch { /* defaults */ }
  const community = links.discord || links.website || links.facebook;

  // A one-tap "add the Testing channel" link + QR. Safe to render publicly because Testing uses the
  // public default/basic key (Rule 6 only forbids surfacing private keys). Opening the link on a
  // phone with Meshtastic adds the channel; ?add=true appends it without touching the primary.
  let testingUrl = "";
  let testingQr = "";
  try {
    testingUrl = await buildChannelSetUrl({ name: "Testing", psk: "AQ==", add: true });
    testingQr = await qrSvg(testingUrl);
  } catch { /* if protobuf/QR fails, the manual name+key below still works */ }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="eyebrow"><span className="eyebrow-bar" />Help &amp; glossary</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-mute">
          New to {brand} or to mesh radio? Start with <Link href="/about" className="text-accent hover:underline">About</Link>,
          then use the glossary and FAQ below.
        </p>
      </div>

      <section className="card space-y-3">
        <h2 className="eyebrow"><span className="eyebrow-bar" />Add a node / join the mesh</h2>
        <ol className="list-decimal space-y-1.5 pl-5 text-[13px] text-ink-mute">
          <li>Get a Meshtastic-compatible LoRa board for your region&apos;s frequency and flash the Meshtastic firmware (meshtastic.org).</li>
          <li>Join the region&apos;s primary channel so your node talks to everyone else.</li>
          <li>Optionally enable MQTT uplink on a gateway node so your traffic reaches this map.</li>
          <li>Say hello in the community below and ask where coverage is needed.</li>
        </ol>
        {community && (
          <a href={community} target="_blank" rel="noopener noreferrer" className="btn btn-primary h-8 w-fit px-3 text-[13px]">Join the community</a>
        )}
      </section>

      <section className="card space-y-3">
        <h2 className="eyebrow"><span className="eyebrow-bar" />Testing channel</h2>
        <p className="text-[13px] leading-relaxed text-ink-mute">
          {brand} runs a public <strong>Testing</strong> channel for range and link tests, so folks can
          check their radio without cluttering the region&apos;s primary channel. It uses Meshtastic&apos;s
          default (basic) key, so anyone can add it:
        </p>
        <ul className="list-disc space-y-1 pl-5 text-[13px] text-ink-mute">
          <li>Channel name: <span className="mono">Testing</span></li>
          <li>Key: <span className="mono">AQ==</span> (the default/basic key, i.e. &quot;Default&quot; in the app)</li>
        </ul>
        {testingUrl && (
          <div className="flex flex-wrap items-center gap-4 rounded-lg border border-line bg-raised/40 p-3">
            {testingQr && (
              <div className="h-28 w-28 shrink-0 rounded bg-white p-1.5 [&_svg]:h-full [&_svg]:w-full" aria-hidden dangerouslySetInnerHTML={{ __html: testingQr }} />
            )}
            <div className="min-w-0 space-y-1.5">
              <p className="text-[13px] text-ink">Add it in one tap:</p>
              <a href={testingUrl} className="btn btn-primary h-8 w-fit px-3 text-[13px]">Add the Testing channel</a>
              <p className="text-[11px] leading-relaxed text-ink-faint">Open on a phone with the Meshtastic app installed, or scan the code. Adds Testing without changing your primary channel.</p>
            </div>
          </div>
        )}
        <p className="text-[13px] leading-relaxed text-ink-mute">
          This server listens on Testing and will respond to what it hears there. Running your own
          monitor or bot? Add the Testing channel and respond there too, so testers get an answer no
          matter whose station hears them.
        </p>
      </section>

      <section className="card space-y-3">
        <h2 className="eyebrow"><span className="eyebrow-bar" />Glossary</h2>
        <dl className="space-y-2.5">
          {GLOSSARY.map((g) => (
            <div key={g.term}>
              <dt className="text-[13px] font-semibold text-ink">{g.term}</dt>
              <dd className="text-[13px] leading-relaxed text-ink-mute">{g.def}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="card space-y-3">
        <h2 className="eyebrow"><span className="eyebrow-bar" />FAQ &amp; troubleshooting</h2>
        <dl className="space-y-2.5">
          {FAQ.map((f) => (
            <div key={f.q}>
              <dt className="text-[13px] font-semibold text-ink">{f.q}</dt>
              <dd className="text-[13px] leading-relaxed text-ink-mute">{f.a}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
