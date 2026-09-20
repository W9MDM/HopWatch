import Link from "next/link";
import { moduleDenied } from "../../../components/ModuleGate.tsx";
import { pageAccess } from "../../../auth/rbac.ts";
import { distinctChannels, getChannelKeys } from "../../../db/settings.ts";
import { effectiveConfig } from "../../../db/appsettings.ts";
import { ChatView } from "../../../components/ChatView.tsx";
import { DbError } from "../../../components/DbError.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

// MeshMonitor-style chat: a live per-channel conversation with ack status on our own sends.
// Complements /messages (the flat heard-messages log) rather than replacing it.
export default async function ChatPage({ searchParams }: { searchParams: Promise<SP> }) {
  const __denied = await moduleDenied("messages"); if (__denied) return __denied;
  // The send box renders only for viewers whose role can transmit (Rule 2: anonymous
  // read-only can never send). The TX API rejects them server-side regardless.
  const canTx = (await pageAccess()).canTx;
  const sp = await searchParams;
  const want = Array.isArray(sp.channel) ? sp.channel[0] : sp.channel;

  let channels: string[] = [], keyedChannels: string[] = [], zone = "UTC";
  let canSend = false, dryRun = true, canned: string[] = [];
  try {
    const cfg = await effectiveConfig();
    zone = cfg.server.local_timezone;
    canSend = cfg.tx.enabled && canTx;
    dryRun = cfg.tx.dry_run;
    canned = cfg.tx.canned_messages ?? [];
    [channels, keyedChannels] = await Promise.all([
      distinctChannels(),
      canSend ? getChannelKeys().then((ks) => ks.map((k) => k.name)) : Promise.resolve([] as string[]),
    ]);
  } catch (e) {
    return <DbError error={e} />;
  }

  const initial = want && channels.includes(want) ? want : (channels[0] ?? "");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="eyebrow"><span className="eyebrow-bar" />Chat</h1>
          <p className="mt-1 text-[13px] text-ink-faint">
            Live per-channel conversation. Your sends show ack status: sent to mesh, heard back, delivered.
          </p>
        </div>
        <Link className="btn btn-outline h-8 px-3 text-[13px]" href="/messages">Message log</Link>
      </div>

      <ChatView
        channels={channels}
        initialChannel={initial}
        zone={zone}
        txEnabled={canSend}
        dryRun={dryRun}
        keyedChannels={keyedChannels}
        canned={canned}
      />
    </div>
  );
}
