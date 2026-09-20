import Link from "next/link";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "../../../auth/session.ts";
import { sessionAccess } from "../../../auth/rbac.ts";
import { loadConfig } from "../../../config/load.ts";
import { seedIngestConfig, listBrokers, listChannelKeyMeta, listForwardRuleMeta, distinctChannels } from "../../../db/settings.ts";
import { listUsers, ensureAdminSeed } from "../../../auth/users.ts";
import { effectiveConfig } from "../../../db/appsettings.ts";
import { DbError } from "../../../components/DbError.tsx";
import { ServiceControls } from "../../../components/ServiceControls.tsx";
import { DiagnosticsCard } from "../../../components/DiagnosticsCard.tsx";
import { SettingsManager } from "../../../components/SettingsManager.tsx";
import { UsersManager } from "../../../components/UsersManager.tsx";
import { NotificationsManager } from "../../../components/NotificationsManager.tsx";
import { ForwardingManager } from "../../../components/ForwardingManager.tsx";
import { DiscordBotManager } from "../../../components/DiscordBotManager.tsx";
import { PositionEstimationManager } from "../../../components/PositionEstimationManager.tsx";
import { RfManager, type RfSettings, type CoverageModel } from "../../../components/RfManager.tsx";
import { GeneralSettingsManager, type GeneralSettings } from "../../../components/GeneralSettingsManager.tsx";
import { ConfigBackupManager } from "../../../components/ConfigBackupManager.tsx";
import { AnalyticsManager, type AnalyticsSettings } from "../../../components/AnalyticsManager.tsx";
import { Tabs } from "../../../components/Tabs.tsx";
import { AuthManager, type AuthInitial } from "../../../components/AuthManager.tsx";
import { getDiscordLink } from "../../../auth/users.ts";
import { TxManager, type TxSettings } from "../../../components/TxManager.tsx";
import { AutomationsManager, type Automation } from "../../../components/AutomationsManager.tsx";
import { AutoResponderManager } from "../../../components/AutoResponderManager.tsx";
import { TracerouteSettingsManager } from "../../../components/TracerouteSettingsManager.tsx";
import { RemoteAdminManager } from "../../../components/RemoteAdminManager.tsx";
import { listRemoteAdmin } from "../../../db/adminscan.ts";
import { WeatherAlertsManager, type WeatherAlertsSettings } from "../../../components/WeatherAlertsManager.tsx";
import { listAlertsSent } from "../../../db/weatheralerts.ts";
import { BridgeManager, type BridgeSettings } from "../../../components/BridgeManager.tsx";
import { listOutbox } from "../../../db/tx.ts";
import { listBridgeLog } from "../../../db/queries.ts";
import { effectiveTopicRoot } from "../../../meshtastic/topic.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
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

  let brokers, keys, users, notif, forwardRules, forwardChannels, posEst, rf, general, coverageModel, authInitial: AuthInitial, analytics: AnalyticsSettings;
  let tx: TxSettings, txNode, txOutbox, automations: Automation[] = [], bridge: BridgeSettings, bridgeBrokers, bridgeChannels, bridgeLog, zone = "UTC";
  let discordBot = { enabled: false, application_id: "", public_key: "", guild_id: "", has_token: false };
  let remoteAdminRows: Awaited<ReturnType<typeof listRemoteAdmin>> = [];
  let wxSent: Awaited<ReturnType<typeof listAlertsSent>> = [];
  let wxSettings: WeatherAlertsSettings;
  let userRoles: { key: string; label: string; admin: boolean }[] = [];
  try {
    try {
      await seedIngestConfig(loadConfig());
    } catch {
      /* config optional */
    }
    const rows = await listBrokers(true);
    brokers = rows.map((r) => ({
      id: r.id, enabled: !!r.enabled, host: r.host, port: r.port, username: r.username,
      has_password: r.password.length > 0, client_id: r.client_id,
      tls_enabled: !!r.tls_enabled, tls_insecure: !!r.tls_insecure, qos: r.qos,
      topics: safeTopics(r.topics), root_topic: r.root_topic ?? "", log_file: r.log_file ?? "",
    }));
    keys = await listChannelKeyMeta();
    await ensureAdminSeed();
    users = await listUsers();
    const eff = await effectiveConfig();
    userRoles = eff.rbac.roles.map((r) => ({ key: r.key, label: r.label, admin: !!r.admin }));
    const smtp = eff.alerts.delivery.smtp;
    notif = {
      smtp: { host: smtp.host, port: smtp.port, user: smtp.user, from: smtp.from, starttls: smtp.starttls, has_password: !!smtp.password },
      // Counts only: these URLs carry their own bearer tokens and must not reach the browser.
      webhook_count: eff.alerts.delivery.webhook.length,
      ntfy_count: eff.alerts.delivery.ntfy.length,
      discord: {
        username: eff.alerts.delivery.discord.username,
        avatar_url: eff.alerts.delivery.discord.avatar_url,
        webhook_count: eff.alerts.delivery.discord.webhooks.length,
      },
      rules: eff.alerts.rules as unknown as { id: string; type: string; enabled: boolean; channels: ("webhook" | "ntfy" | "discord" | "smtp")[] }[],
      digest: {
        enabled: Boolean((eff.digest as Record<string, unknown>).enabled),
        time: String((eff.digest as Record<string, unknown>).time ?? "08:00"),
        channels: (((eff.digest as Record<string, unknown>).channels as ("webhook" | "ntfy" | "discord" | "smtp")[]) ?? []),
        attach_ics: Boolean((eff.digest as Record<string, unknown>).attach_ics),
      },
    };
    forwardRules = await listForwardRuleMeta();
    forwardChannels = await distinctChannels();
    posEst = eff.position_estimation;
    rf = eff.rf as unknown as RfSettings;
    coverageModel = eff.coverage as unknown as CoverageModel;
    analytics = {
      spam_score: { window_hours: eff.analytics.spam_score.window_hours },
      records: { enabled: eff.analytics.records.enabled },
      health_score: { weights: eff.analytics.health_score.weights },
      rollups: { refold_hours: eff.analytics.rollups.refold_hours },
    };
    general = {
      display: { brand_name: eff.server.ui.brand_name, brand_icon: eff.server.ui.brand_icon, local_timezone: eff.server.local_timezone, public_url: eff.server.public_url, temperature_unit: eff.server.ui.temperature_unit, tile: eff.server.ui.tile_provider, tile_dark: eff.server.ui.tile_provider_dark },
      // Never send the decrypted GA api_secret to the client; report only whether one is set.
      analytics: { enabled: eff.server.ui.analytics.enabled, measurement_id: eff.server.ui.analytics.measurement_id, client: eff.server.ui.analytics.client, server: eff.server.ui.analytics.server, has_api_secret: !!eff.server.ui.analytics.api_secret },
      map_max_age: eff.server.ui.map_max_age,
      map_center: eff.server.ui.map_center,
      social_links: eff.server.ui.social_links,
      privacy: { metrics_public: eff.server.metrics_public, fuzz_positions: eff.server.privacy.fuzz_positions, fuzz_decimals: eff.server.privacy.fuzz_decimals },
      retention: eff.retention,
      features: eff.features,
      livemap: eff.livemap,
    } as unknown as GeneralSettings;
    const dc = eff.server.auth.discord;
    authInitial = {
      discord: { enabled: dc.enabled, client_id: dc.client_id, redirect_url: dc.redirect_url, has_secret: !!dc.client_secret, auto_provision: dc.auto_provision },
      session_ttl_hours: eff.server.auth.session_ttl_hours,
      anonymous_read_only: eff.server.auth.anonymous_read_only,
      linkedDiscord: await getDiscordLink(session.sub),
    };
    // Transmit + MQTT bridge, so they can live as tabs here instead of separate pages.
    zone = eff.server.local_timezone;
    tx = eff.tx as unknown as TxSettings;
    txNode = eff.node;
    automations = eff.automations as unknown as Automation[];
    bridge = eff.bridge as unknown as BridgeSettings;
    wxSettings = eff.weather_alerts as unknown as WeatherAlertsSettings;
    discordBot = {
      enabled: eff.discord_bot.enabled, application_id: eff.discord_bot.application_id,
      public_key: eff.discord_bot.public_key, guild_id: eff.discord_bot.guild_id, has_token: !!eff.discord_bot.bot_token,
    };
    [txOutbox, bridgeChannels, bridgeLog, remoteAdminRows, wxSent] = await Promise.all([listOutbox(50), distinctChannels(), listBridgeLog(100), listRemoteAdmin(), listAlertsSent(50)]);
    bridgeBrokers = rows.map((r) => {
      let topics: string[] = [];
      try { const a = JSON.parse(r.topics); if (Array.isArray(a)) topics = a.map(String); } catch { /* ignore */ }
      const er = effectiveTopicRoot(r.root_topic, topics);
      return { id: r.id, host: r.host, root: er.root, rootSource: er.source };
    });
  } catch (e) {
    return <DbError error={e} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="eyebrow">
          <span className="eyebrow-bar" />
          Settings
        </h1>
        <div className="flex items-center gap-3">
          <ServiceControls />
          <span className="text-[11px] text-ink-faint">signed in as {session.sub}</span>
        </div>
      </div>
      <p className="text-[13px] text-ink-faint">
        Changes are picked up within about 5 seconds, with no restart.
      </p>
      <Tabs
        tabs={[
          { id: "general", label: "General", panel: <div className="space-y-4"><GeneralSettingsManager initial={general} /><ConfigBackupManager /></div> },
          { id: "access", label: "Login & access", panel: <div className="space-y-4"><AuthManager initial={authInitial} /><UsersManager initial={users} currentUser={session.sub} roles={userRoles} /></div> },
          { id: "ingest", label: "Ingest (brokers)", panel: <SettingsManager initialBrokers={brokers} initialKeys={keys} /> },
          { id: "notifications", label: "Notifications", panel: <div className="space-y-4"><NotificationsManager initial={notif} /><ForwardingManager initial={forwardRules} channels={forwardChannels} /><DiscordBotManager initial={discordBot} /></div> },
          { id: "rf", label: "RF & position", panel: <div className="space-y-4"><RfManager initial={rf} coverage={coverageModel} /><PositionEstimationManager initial={posEst} /></div> },
          { id: "analytics", label: "Analytics", panel: <AnalyticsManager initial={analytics} /> },
          { id: "tx", label: "Transmit", panel: <TxManager initial={tx} initialNode={txNode} initialOutbox={txOutbox} brokers={brokers.map((r) => ({ id: r.id, host: r.host }))} zone={zone} /> },
          { id: "autoresponder", label: "Auto-responder", panel: <AutoResponderManager initial={tx.auto_responder} /> },
          { id: "automations", label: "Automations", panel: <AutomationsManager initial={automations} /> },
          { id: "traceroutes", label: "Traceroutes", panel: <TracerouteSettingsManager initial={{ traceroute_cooldown_s: tx.traceroute_cooldown_s, auto_traceroute: tx.auto_traceroute }} /> },
          { id: "remote-admin", label: "Remote admin", panel: <RemoteAdminManager initialSettings={tx.admin_scanner} initialRows={remoteAdminRows} /> },
          { id: "weather-alerts", label: "Weather alerts", panel: <WeatherAlertsManager initial={wxSettings} initialSent={wxSent} channels={bridgeChannels} brokers={brokers.map((r) => ({ id: r.id, host: r.host }))} /> },
          { id: "diagnostics", label: "Diagnostics", panel: <DiagnosticsCard /> },
          { id: "bridge", label: "MQTT bridge", panel: <BridgeManager initial={bridge} brokers={bridgeBrokers} channels={bridgeChannels} initialLog={bridgeLog} zone={zone} /> },
        ]}
      />
    </div>
  );
}

function safeTopics(t: string): string[] {
  try {
    const a = JSON.parse(t);
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}
