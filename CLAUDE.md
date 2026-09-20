# HopWatch - CLAUDE.md

Read this before writing any code in this repo. These rules are not suggestions. If a
change violates a rule, the change is wrong, not the rule.

HopWatch is a self-hosted Meshtastic MQTT network observatory: three Node processes
(ingest, worker, web) that share one MySQL database, built around "receptions, not
packets."

---

## RULE 1: Settings live in the database, managed in the admin UI. Never in env.

Every setting in HopWatch is stored in the database, encrypted where sensitive
(AES-256-GCM), and managed through `/admin/settings`. Hot-reload picks up changes within
~5s. This is already how brokers, channel keys, forwarding rules, and position estimation
work. Every new feature follows the same pattern.

**Never do any of these:**

- Add a new `HOPWATCH_*` env var for a setting, flag, toggle, threshold, interval, host,
  port, path, or feature switch.
- Add a new key to `config/hopwatch.yaml` as the source of truth. YAML exists only to seed
  the database on first run, nothing else. Prefer no YAML seed at all: new features ship
  with sane defaults in the settings schema and are configured in the UI.
- Read `process.env` anywhere outside the config/bootstrap layer.
- Gate behavior on an env var "just for this one case" (kill switches, debug flags, dry-run
  modes included). Runtime toggles are settings. Put them in the DB, surface them in
  `/admin`, let hot-reload deliver them.

**The only permitted env vars are the bootstrap set** - things that cannot come from the
database because they are required to reach or decrypt it:

- `HOPWATCH_DB_HOST` / `HOPWATCH_DB_PORT` / `HOPWATCH_DB_NAME` / `HOPWATCH_DB_USER` /
  `HOPWATCH_DB_PASSWORD` (or socket path)
- `HOPWATCH_MASTER_KEY` (decrypts secrets stored in the DB; falls back to
  `HOPWATCH_SESSION_SECRET`)
- `HOPWATCH_SESSION_SECRET`, `HOPWATCH_ADMIN_PASSWORD`
- `NODE_ENV` / `PORT`

That list is closed. If you think a new feature needs an env var, it does not. It needs a
settings entry with a default, an admin UI control, and hot-reload wiring.

### How settings actually work in this repo

The mechanism is not a standalone "settings service"; it is:

1. **Defaults + validation:** the Zod schema in `src/config/schema.ts`. This is the allowed
   home for defaults (not YAML).
2. **Runtime read:** `effectiveConfig()` in `src/db/appsettings.ts` = file config deep-merged
   with the UI-editable `app_setting.config_overrides` JSON. Consume settings through
   `effectiveConfig()`, never `loadConfig()`, in ingest/worker/web.
3. **Admin write:** `saveOverrides(patch)` persists the override JSON and calls `bumpRev()`,
   which the ingest daemon polls every ~5s to hot-reload.
4. **Per-feature tables** (`mqtt_broker`, `channel_key`, `forward_rule`) live in
   `src/db/settings.ts` for list-shaped settings.

### How to add a setting (the only acceptable pattern)

1. Add the key + default to the Zod schema in `src/config/schema.ts`.
2. Read it via `effectiveConfig()` in the consumer. Encrypt credentials/targets with
   `encryptSecret` (add the dotted path to `SECRET_PATHS` in `appsettings.ts`).
3. Add a `*Manager.tsx` control to `/admin/settings` plus an admin API route that does
   `GET effectiveConfig -> POST saveOverrides`. Copy `/api/v1/admin/notifications` or
   `/api/v1/admin/position-estimation`.
4. Document it in the settings docs, not `.env.example`.

---

## RULE 2: Passive by default. Transmit only through the armed, audited TX subsystem.

HopWatch is passive out of the box, but it is no longer strictly receive-only: an opt-in TX
subsystem (v2.0) can publish to the mesh. Transmitting is a privilege, not a default.

- A fresh install transmits nothing. TX requires BOTH `tx.enabled` (config, default false)
  AND a runtime `tx.armed` toggle set by an admin. `tx.dry_run` (default true) runs the full
  pipeline but publishes nothing. Disarming is the kill switch and halts the queue within one
  worker tick.
- **No code path publishes directly.** Every transmission goes through `tx_outbox`: a request
  is queued, the worker enforces the safety rails (arm state, rate limits, channel-util guard,
  mute list, hop-limit cap), transmits, and records confirmations. The rails live in the
  worker, never the UI.
- Every send is attributable (which user queued it) and lands in the immutable audit log,
  including dry-run and failed sends. Anonymous read-only can never send; token users need
  `can_tx`.
- Still forbidden regardless of TX: **spoofing** another node on RF (transmitting a packet whose
  `from` is not our own node). HopWatch's RF TX speaks only as its own configured node.
- **Sanctioned exception: the RF<->MQTT patcher** (opt-in, off by default; `bridge.rf_to_mqtt`,
  `bridge.mqtt_to_rf`). It makes HopWatch a cross-transport text bridge like a Meshtastic gateway:
  RF-heard text is uplinked to MQTT *faithfully* (original sender preserved, re-encrypted) since
  MQTT is not the air; MQTT-heard text is *re-originated as HopWatch's own TX node* onto RF via the
  armed `tx_outbox` (never spoofs the sender), so the RF half still obeys every TX rail + audit. A
  hold timer (`bridge.patch_hold_seconds`) skips any message that already reached the other
  transport on its own, so it never doubles a real gateway's (or the station node's own) bridging.
- **One sanctioned exception to "no rebroadcasting": the MQTT text bridge** (opt-in, off by
  default). It may forward `TEXT_MESSAGE_APP` packets between MQTT brokers (server-to-server
  federation), and ONLY packets whose sender set the OK-to-MQTT bit (`bridge.require_ok_to_mqtt`,
  default true). It requires BOTH `bridge.enabled` (config) AND a runtime `bridge.armed` toggle;
  it forwards nothing else (no telemetry/position/nodeinfo), never bridges peer-to-peer (only
  local<->peer), dedups by packet id to prevent loops, and logs every forward to `bridge_log`.
  This is MQTT-layer federation, not an RF transmit, so it does not go through `tx_outbox`.
- Ingest is MQTT for RX and, when the bridge is armed, MQTT-publish for that bridge only; the
  optional station-node transport (phase 2) is the only sanctioned direct-to-node connection.

See `docs/tx.md` for the TX safety model and `docs/bridge.md` for the MQTT bridge.

---

## RULE 3: No em dashes or en dashes. Anywhere.

Never emit U+2014 (em dash) or U+2013 (en dash) in code, comments, UI copy, docs, commit
messages, or generated content. Use ASCII hyphens, commas, colons, or reworded sentences.
This is a hard rule of the TARA design system and applies to everything, including this
file. Grep before finishing:

```bash
grep -rlP "[\x{2013}\x{2014}]" src db config *.md
```

---

## RULE 4: Receptions, not packets.

One mesh packet uplinked by N gateways is one logical `packet` row plus N `reception` rows.
Every analytic (coverage, gateway compare, direct-heard attribution, link quality, position
estimation) builds on receptions. Distance/RF math uses zero-hop (`rf_direct`) receptions
only; relayed receptions say nothing about source-to-receiver distance and must be excluded.

---

## RULE 5: Processes talk only through the database.

`ingest`, `worker`, and `web` are independent, restart-safe processes. They share state
exclusively via MySQL (settings via `config_overrides`/`bumpRev`, live events via the
`live_events` tail, everything else via tables). No shared memory, no direct IPC, no HTTP
between them.

---

## RULE 6: Secrets are encrypted at rest; only the master key lives in env.

**No key, credential, token, password, PSK, or secret is ever stored, committed, or transmitted
in plaintext. Ever.** A secret lives in exactly one of two places: AES-256-GCM encrypted in the
database (`src/lib/secrets.ts`, with its dotted path listed in `SECRET_PATHS`), or in the
environment for the closed bootstrap set only (the keys needed to reach or decrypt the DB). It
never appears in source code, in `config/*.yaml` (committed or not), in a git commit, in logs, in
an error message, in an API response, or anywhere a client can read it. A URL that embeds a token
(a Discord/Apprise webhook, for example) is itself a secret and is encrypted the same way and
reported to the client as a count or `has_password`, never returned.

Operational secrets (broker/SMTP passwords, Discord client secret, forwarding/webhook targets,
channel PSKs) are AES-256-GCM encrypted in the database via `src/lib/secrets.ts`. The master key
(`HOPWATCH_MASTER_KEY`, fallback `HOPWATCH_SESSION_SECRET`) is the one secret that stays in the
environment because it decrypts the rest. Never log, return, or round-trip a decrypted secret to
the client; admin GETs report `has_password: true/false`, never the value. When you add a new
setting that holds a secret, add its dotted path to `SECRET_PATHS` in the same change.

---

## RULE 7: Stack constraints.

- **MySQL 8 / MariaDB**, not Postgres. **No Docker.** Deploy via the install scripts and
  systemd units (`scripts/linux-install.sh`, `deploy/systemd/`).
- Node.js 22.6+ (uses native TypeScript type-stripping; tests run under `node --test`).
- Next.js App Router + Radix UI + Tailwind v4, MapLibre GL, uPlot, mqtt.js,
  `@bufbuild/protobuf` + `@meshtastic/protobufs`, nodemailer, prom-client.
- `@meshtastic/protobufs` is isolated to `src/meshtastic/decode.ts`; a version bump that
  renames an export is fixed only there.

---

## RULE 8: Migrations.

- Schema changes are ordered SQL files in `db/migrations/NNNN_name.sql`, applied in filename
  order and recorded in `schema_migrations`. They run automatically on `ingest`/`worker`
  startup (and `npm run migrate`); `web` does not run them.
- The runner strips `--` comments then splits on `;`, so no stored routines and no `;`
  inside a statement that is not a real terminator.
- Estimates/derived data go in their own tables with their own provenance; never merge
  inferred data into an authoritative table (e.g. `position_estimate` never writes to
  `node_positions`).

---

## RULE 9: Map UI conventions.

All three maps (`/map`, `/livemap`, `/coverage`) stay consistent:

- Controls (dark/light, names on/off, short names on/off, estimated on/off, broker/channel
  filters) render in a row **above** the map, never floating over the canvas.
- The key/legend is **always visible above the map**, not a collapsible button. The hop
  legend shows every ring 0,1,2,3,4,5,6,7+ from `HOP_SCALE`.
- Popups use `className: "hw-popup"` with a themed inner card. The `.hw-popup` CSS must live
  **outside** `@layer` in `globals.css` (maplibre-gl.css is imported unlayered and would
  otherwise win, showing a white box in dark mode).
- Estimated (non-GPS) nodes render as dashed markers in the estimate color with a translucent
  confidence circle, and are clearly distinguished from real positions everywhere including
  the API (`position_source: estimated`).
- Shared localStorage keys: `hopwatch_map_dark`, `hopwatch_map_labels`,
  `hopwatch_map_shortnames`, `hopwatch_map_estimated`, `hopwatch_map_rfonly`,
  `hopwatch_livemap_audio`.

---

## RULE 10: Time is UTC.

All datetimes are stored in UTC (`toMysqlUtc`). The UI renders `server.local_timezone`.
Never store or compare local time.

---

## RULE 11: Documentation ships with the change, not later.

Docs are part of the definition of done. A change that alters observable surface is not
complete until the docs that describe that surface are updated in the same change. Stale docs
are treated as a bug.

Update the doc that owns each kind of surface:

- **New/changed/removed setting** (schema key, default, admin control): `docs/config.md`, and
  `docs/tx.md` or `docs/rbac.md` if it belongs to those subsystems. Per Rule 1, the Zod schema
  in `src/config/schema.ts` is the source of truth; the docs must match its keys and defaults
  exactly (no phantom keys, no missing sections).
- **New/changed page or feature**: the README "Web UI" / feature lists.
- **New/changed API route** (path, method, read-vs-write, auth/module gate): the README "API
  and metrics" section. The API description must stay honest about what can write.
- **New module, role default, or auth/sign-in behavior**: `docs/rbac.md`.
- **New TX behavior, kind, state, transport, or safety rail**: `docs/tx.md`.

`HopWatch-Design-Spec.md` is a historical architecture doc: do not rewrite it per change, but
if a change contradicts a specific claim in it (e.g. "passive observer only"), correct or
annotate that claim so the spec never actively lies.

Names and values in docs must be copy-pasteable: a config key or endpoint path quoted in a doc
must exist verbatim in the code. Grep before finishing.

---

## RULE 12: Commit each finished task or module.

When a task or self-contained module is complete, verified, and its docs are updated, make a
git commit for it before moving on. Do not batch several unrelated features into one commit,
and do not leave finished work uncommitted across tasks.

- A commit is warranted once the unit is done and green: `npx tsc --noEmit`, `npx next build`,
  and `node --test "test/**/*.test.ts"` pass, and the pre-commit checklist below holds.
- One logical change per commit, with a message that says what shipped and why. Add NO authorship
  or co-authorship trailer: per the ownership rules at the end of this file, commits carry no
  Anthropic/Claude metadata. Existing history is left alone (rewriting it would change every hash).
- If on the default branch, follow the repo's established flow (this project commits to `main`).
- Push to origin immediately after every commit (`git push`). Do not leave commits sitting
  local-only; the operator deploys from the remote.

---

## RULE 13: Bump the version on every commit.

Every commit bumps `version` in `package.json` by one patch level (`0.1.0` -> `0.1.1` -> `0.1.2`,
rolling `.99` up to the next minor). The version is a monotonic build counter: it is shown with
the git commit in the profile menu (`v0.1.7 - <commit>`) so an operator can tell at a glance
which build is deployed. One commit, one bump, in the same commit as the change.

- Patch is the default step. Use a minor bump (`0.2.0`) only when the user asks for one to mark a
  milestone; never reset or move it backward.
- `src/lib/version.ts` reads `package.json`; do not hardcode the version anywhere else.

---

## Pre-commit checklist

- [ ] `git grep -n "process.env"` shows nothing new outside the config/bootstrap layer.
- [ ] No new `.env.example` keys; no new YAML config keys unless a pure first-run seed with a
      UI owner.
- [ ] Every new toggle/threshold/credential is visible and editable in `/admin`.
- [ ] Docs updated in this change (Rule 11): settings -> `docs/config.md`, pages/features and
      API routes -> README, roles/auth -> `docs/rbac.md`, TX -> `docs/tx.md`. Every key/path
      quoted in a doc exists verbatim in the code.
- [ ] No em/en dashes: `grep -rlP "[\x{2013}\x{2014}]" src db config *.md` is clean.
- [ ] Nothing transmits except through `tx_outbox` behind arm + safety rails; a fresh
      install (tx disabled/disarmed) publishes nothing.
- [ ] Version bumped one patch level in `package.json` (Rule 13).
- [ ] `npx tsc --noEmit`, `npx next build`, and `node --test "test/**/*.test.ts"` all pass.

---

## Project layout

```
config/                 example YAML config (first-run seed only)
db/migrations/          ordered SQL schema (partitioned tables, rollups, estimate tables)
src/config/             Zod schema + loader (defaults live here, not YAML)
src/meshtastic/         topic parse, decode, crypto, reception classification
src/ingest/             broker connectors, dedup, ingest pipeline, daemon entry
src/worker/             rollups, retention, RF/propagation, position estimation, forwarding
src/db/                 pool, migrate runner, read queries, settings + config overrides
src/app/                Next.js App Router pages + API routes (+ /admin, /api/v1/admin)
src/lib/                time (UTC), formatting, csv, geo, map icons, estimation math, secrets
test/                   pure-logic unit tests (node --test, no DB)
```

---

# Repository Guidelines & Ownership Rules

## Intellectual Property & Code Ownership
- **Strict User Ownership:** All code, documentation, scripts, and assets generated, modified, or assisted with in this repository are created under the direct instruction of the user and belong exclusively to the user.
- **No Self-Attribution:** Do NOT add copyright notices, author tags, or ownership headers claiming rights, authorship, or creation over any file or snippet (e.g., do NOT use `@author Claude`, `Copyright Anthropic`, or `Created by Claude`).
- **Header Integrity:** Maintain existing project copyright headers, license files, and author notices. Do not modify or inject Anthropic/Claude metadata into file headers or inline documentation unless explicitly instructed.

## System Behavior
- Act strictly as an automated AI coding assistant and tool.
- Respect the license terms present in the root of this repository.
