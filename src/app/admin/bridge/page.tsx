import Link from "next/link";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "../../../auth/session.ts";
import { sessionAccess } from "../../../auth/rbac.ts";
import { effectiveConfig } from "../../../db/appsettings.ts";
import { listBrokers, distinctChannels } from "../../../db/settings.ts";
import { listBridgeLog } from "../../../db/queries.ts";
import { effectiveTopicRoot } from "../../../meshtastic/topic.ts";
import { DbError } from "../../../components/DbError.tsx";
import { BridgeManager, type BridgeSettings } from "../../../components/BridgeManager.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminBridgePage() {
  const jar = await cookies();
  const session = verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!session || !(await sessionAccess(session)).admin) {
    return (
      <div className="mx-auto max-w-sm py-16 text-center">
        <p className="text-[13px] text-ink-mute">Admin access required.</p>
        <Link className="btn btn-primary mt-3 h-9 px-4 text-[13px]" href="/admin/login">Sign in</Link>
      </div>
    );
  }

  let bridge: BridgeSettings, brokers, channels, log, zone = "UTC";
  try {
    const cfg = await effectiveConfig();
    bridge = cfg.bridge as unknown as BridgeSettings;
    zone = cfg.server.local_timezone;
    [brokers, channels, log] = await Promise.all([listBrokers(), distinctChannels(), listBridgeLog(100)]);
  } catch (e) {
    return <DbError error={e} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="eyebrow"><span className="eyebrow-bar" />MQTT bridge</h1>
        <Link className="btn btn-outline h-8 px-3 text-[13px]" href="/admin/settings">Ingest settings</Link>
      </div>
      <BridgeManager
        initial={bridge}
        brokers={brokers.map((b) => {
          let topics: string[] = [];
          try { const a = JSON.parse(b.topics); if (Array.isArray(a)) topics = a.map(String); } catch { /* ignore */ }
          const r = effectiveTopicRoot(b.root_topic, topics);
          return { id: b.id, host: b.host, root: r.root, rootSource: r.source };
        })}
        channels={channels}
        initialLog={log}
        zone={zone}
      />
    </div>
  );
}
