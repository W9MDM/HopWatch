# HopWatch setup guide

A start-to-finish guide to standing up your own HopWatch instance. HopWatch is passive by
default: a fresh install only observes an MQTT broker and never transmits.

There are two paths: a **one-command Linux install** (recommended for a server) and a
**manual/cross-platform** path (good for a laptop or development). Either way, you configure
brokers, channels, alerts, roles, and TX **in the admin UI** afterward, never by hand-editing
files.

## What you need

- **Node.js 22.6 or newer** (24 recommended). No Docker.
- **MySQL 8** or **MariaDB 10.5+** you can reach (the Linux installer can create a local MariaDB
  database for you).
- At least one **MQTT broker** carrying Meshtastic traffic. The public default is
  `mqtt.meshtastic.org`; a regional or private broker works too. You add this in the UI, not now.

## Option A: Linux server (one command)

From the app directory (for example `/opt/hopwatch`), with MariaDB installed:

```bash
sudo bash scripts/linux-install.sh
```

This installs dependencies, **generates strong random secrets**, creates the database and user via
MariaDB socket login, points the app at the unix socket, runs migrations, builds, and installs +
enables three `systemd` services (`hopwatch-ingest`, `hopwatch-worker`, `hopwatch-web`). It prints
a generated admin password once - save it.

Flags: `--no-db`, `--no-systemd`, `--no-build`, `--user=NAME`.

## Option B: manual / cross-platform

```bash
# 1. install deps, create config + .env, generate secrets, run migrations
npm run setup           # or: ./install.sh   (Windows: .\install.ps1)

# 2. point the app at your database
#    edit .env: set HOPWATCH_DB_HOST / _PORT / _NAME / _USER / _PASSWORD
#    (the session/master/admin secrets were generated for you; do not edit them)

# 3. start the three processes (separate terminals, or a process manager)
npm run ingest          # subscribes to brokers, writes packets/receptions
npm run worker          # rollups, retention, alerts, position estimation, TX
npm run start           # the web UI + API (default http://localhost:3000)
```

`npm run setup` copies `config/hopwatch.example.yaml` -> `config/hopwatch.yaml` and
`.env.example` -> `.env`, then replaces the example secret placeholders with strong random values
and locks `.env` to owner-only. **You never paste secrets into the repo.**

## Secrets, in one paragraph

Only *bootstrap* secrets live in `.env`: the database credentials, `HOPWATCH_SESSION_SECRET`
(signs admin sessions), `HOPWATCH_MASTER_KEY` (encrypts everything else at rest), and a one-time
`HOPWATCH_ADMIN_PASSWORD` seed. Setup generates all of these. Every *operational* secret you enter
later - broker/SMTP passwords, channel PSKs, Discord tokens, webhook URLs - is **AES-256-GCM
encrypted in the database** with the master key and is never returned to the browser. Admin
passwords are stored scrypt-hashed. In production the app refuses to start if the session secret is
empty or still an example placeholder, so a forgeable admin session cannot happen by accident.

## First run

1. Open the web UI (`http://<host>:3000` or your reverse-proxied domain).
2. Sign in at `/admin/login` as `admin` with the generated password. Change it under
   **Settings -> Users**.
3. **Settings -> Ingest (brokers):** add your MQTT broker (host, port, topics such as
   `msh/US/#`). Ingest hot-reloads within about 5 seconds; packets start flowing.
4. **Settings -> Ingest (channel keys):** add any channel keys you want decrypted (the default
   `AQ==` key covers the default LongFast/LongTurbo channels).
5. Watch the dashboard, the live map, and `/packets` populate.

Everything after step 2 is done in the UI and takes effect without a restart. See
[config.md](config.md) for the full settings reference, [rbac.md](rbac.md) for roles and sign-in,
[tx.md](tx.md) for the opt-in transmit subsystem, and [bridge.md](bridge.md) for the MQTT text
bridge.

## Upgrading

```bash
git pull
npm install
npm run migrate          # applies any new DB migrations
# rebuild the web app and restart the services
```

On systemd installs, `scripts/linux-update.sh` does the pull/build/restart for you.
