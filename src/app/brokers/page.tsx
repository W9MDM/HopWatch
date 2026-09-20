import { moduleDenied } from "../../components/ModuleGate.tsx";
import { pageAccess } from "../../auth/rbac.ts";
import {
  brokerPresence, listGateways, mqttClients,
  type BrokerPresence, type MqttClientRow,
} from "../../db/queries.ts";
import { BrokerTabs, type BrokerGateway } from "../../components/BrokerTabs.tsx";
import { DbError } from "../../components/DbError.tsx";
import { AutoRefresh } from "../../components/AutoRefresh.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = { title: "MQTT brokers" };

export default async function BrokersPage() {
  const __denied = await moduleDenied("gateways"); if (__denied) return __denied;
  const isAdmin = (await pageAccess()).admin;

  let brokers: BrokerPresence[], gateways: BrokerGateway[], clientLists: MqttClientRow[][];
  try {
    [brokers, gateways] = await Promise.all([brokerPresence(), listGateways()]);
    // Per-broker connected-client rosters (empty for brokers without a configured log).
    clientLists = await Promise.all(brokers.map((b) => mqttClients(b.broker_id)));
  } catch (e) {
    return <DbError error={e} />;
  }

  const rosters: Record<string, BrokerGateway[]> = {};
  for (const g of gateways) (rosters[g.broker_id ?? ""] ??= []).push(g);

  const clients: Record<string, MqttClientRow[]> = {};
  brokers.forEach((b, i) => { clients[b.broker_id] = clientLists[i] ?? []; });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="eyebrow"><span className="eyebrow-bar" />MQTT brokers</h1>
        <AutoRefresh />
      </div>

      <p className="text-[13px] text-ink-faint">
        Per-broker presence, one tab each. <b className="text-ink-mute">Clients connected</b> is the live count from the
        broker&apos;s <span className="mono">$SYS</span> feed. <b className="text-ink-mute">Connected clients</b> lists each
        one by name when we can read the broker&apos;s log (the local broker); Mosquitto does not expose client identities
        over <span className="mono">$SYS</span>, so a broker with no log configured shows only the count and the
        <b className="text-ink-mute"> gateway roster</b> (Meshtastic gateways seen publishing, with last-seen).
      </p>

      <BrokerTabs brokers={brokers} rosters={rosters} clients={clients} isAdmin={isAdmin} />
    </div>
  );
}
