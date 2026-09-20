# Access control (RBAC) and sign-in

HopWatch gates every feature behind role-based access control. A **role** grants a set of
**modules** (feature areas); a request that maps to a module the caller's role lacks is
hard-blocked: the nav hides it, and the page and API route both return 403. Roles are stored in
the database and edited in `/admin/roles` (hot-reloaded, per `CLAUDE.md` Rule 1); defaults live
in the `rbac` block of `src/config/schema.ts`.

## Who gets which role

- **Anonymous** requests resolve to `rbac.anonymous_role` (default `public`). Only applies when
  `server.auth.anonymous_read_only` is true; when false, anonymous requests are denied and a
  bearer token is required.
- **API tokens** resolve to their own `role_key`, or `rbac.token_default_role` (default
  `viewer`) if unset. Tokens are API-only (no page access).
- **Signed-in accounts** resolve to their own stored role (`admin_users.role`), which is
  authoritative and re-read from the database on every request (not cached in the session
  cookie), so a demotion or admin-revocation takes effect on the user's next request rather than
  at cookie expiry. Admins set it per user in `/admin/settings` -> Users &amp; access, choosing any
  defined role. New auto-provisioned Discord logins start at `rbac.member_role` (default
  `member`) and can then be raised or lowered. If a user's stored role key no longer exists, it
  falls back to `member_role`.
- **Admins** (a role with `admin: true`, the built-in `admin` key) always get every module and
  the admin API surface. You cannot strip your own admin role or demote the last admin.

## Managing users

`/admin/settings` -> **Users &amp; access** lists both password accounts and Discord-provisioned
accounts, each with an inline role dropdown (any defined role). Adding an existing username
resets that user's password and role; Discord-only accounts (no password) are re-rolled with
the same dropdown. Role definitions and their module access are edited under **Roles &amp;
access** (`/admin/roles`).

## Modules

Every page/feature area is a module (`src/auth/modules.ts`), and guards map a request path to a
module by longest-prefix match. Current keys:

`dashboard`, `livemap`, `map`, `coverage`, `history`, `graph`, `nodes`, `owned`, `watchlist`,
`power` (also `/battery`, `/routers`), `packets`, `gateways`, `messages`, `matrix`,
`analytics` (also `/stats`, `/distributions`), `propagation`, `link-budget` (also `/los`),
`records`, `fleet`, `traceroutes`, `backbone`, `new-nodes`, `ghosts`, `spammers`, `weather`,
`environment`, `ambience`, `replay`, `health`, `site-planner`, `scoreboard`, `flags`, `kiosk`,
`api` (the OpenAPI doc), `admin`.

## Seeded roles

| Role | Admin | can_tx | Modules |
|---|---|---|---|
| `admin` | yes | yes | all |
| `viewer` | no | no | all except `admin` |
| `member` | no | no | dashboard, map, livemap, coverage, history, nodes, owned, watchlist, power, gateways, messages, records |
| `public` | no | no | member's set minus owned, watchlist |

A role's `can_tx` flag grants transmit to its members/tokens (see `docs/tx.md`). Admin sessions
can always transmit. The roles editor refuses to save if no admin role would remain, and
forbids setting an anonymous or token-default role that is itself an admin role.

## Enforcement

- **Pages:** each page early-returns via a module gate (`src/components/ModuleGate.tsx`); the
  root layout computes allowed modules from `pageAccess()` and filters the nav (`NavMenu`).
- **API:** every read route calls `requireModule(req, "<key>")`; TX routes call `requireTx`;
  the SSE stream, the `.ics` feed, and `openapi.json` are gated too. There is no fail-open read
  path (the old `requireRead` helper was removed).
- Resolver: `src/auth/rbac.ts` (`resolveAccess` for API, `pageAccess` for pages).
- **The cookie's role is never an authorization source.** `signSession` stamps the role at login for
  `server.auth.session_ttl_hours` (default 30 days) and nothing invalidates sessions when a role
  changes, so `sessionAccess`/`pageAccess` re-read the account's stored role on every request and
  fail closed for a deleted account (falling back to the cookie only on a genuine DB outage, so a
  blip does not lock operators out). Everything downstream takes `admin` from that resolved access,
  including `requestActor`/`actorFor` for owned-node writes, the nav and command palette, the
  profile page and API, the new-node feed controls, and `/api/metrics` when `metrics_public` is off.
  `test/authsession.test.ts` fails the build if any module outside `src/auth/session.ts` and
  `src/auth/rbac.ts` reads `session.role`, or compares a role against the literal `"admin"` (which
  cannot see a custom admin role).
- **A module grant is not a session.** `resolveAccess` hands out the anonymous role whenever
  `server.auth.anonymous_read_only` is on (the default), and nothing stops an operator granting a
  module to the anonymous role, so any route that reveals accounts needs its own signed-in check on
  top of the module gate. Every route under `owned/` calls `requestActor` and answers 401 without a
  session, including the read-only `owned/meta` and `owned/groups/{id}/members` pickers. A user's
  Discord handle is admin-only: `owned/meta` returns `discord_username: null` to non-admins.
- **Position privacy is enforced per surface, not per module.** `server.privacy.fuzz_positions` is
  applied by every page and route that emits coordinates (see `docs/config.md`); a static test,
  `test/positionprivacy.test.ts`, fails the build if a new one is added without it.

## Discord SSO

When `server.auth.discord.enabled` is true, `/admin/login` offers "Sign in with Discord".

1. Register an OAuth application in the Discord developer portal.
2. Set its redirect to `https://<host>/api/v1/auth/discord/callback`.
3. In `/admin/settings`, enter `client_id`, `client_secret` (encrypted at rest), and
   `redirect_url`.

A Discord login resolves to `rbac.member_role`. With `auto_provision` true (default), a login
with no linked account creates a non-admin account and signs in; with it false, only
pre-linked accounts succeed. Users link/unlink Discord from their profile; admins can
force-unlink via `/api/v1/admin/discord-unlink`. Discord identity fields live on `admin_users`
(`discord_id`, `discord_username`, migration `0019_discord_auth.sql`).
