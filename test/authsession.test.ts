import { test } from "node:test";
import assert from "node:assert/strict";
import { signSession, verifySession } from "../src/auth/session.ts";
import { signState, verifyState } from "../src/auth/oauth.ts";
import { hmac } from "../src/auth/crypto.ts";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

// Security invariants for the signed-cookie auth. These pin a real privilege-escalation path:
// signState and signSession both signed `base64url(json).hmac` with the same secret and no domain
// separation, and verifySession validated only `exp` -- a field OAuthState also carries. Because
// GET /api/v1/auth/discord mints a state token for an ANONYMOUS caller, anyone could take one and
// replay it as hopwatch_session; role resolution then found no user for the undefined `sub` and
// fell through to the member role, defeating anonymous_read_only=false.

test("an OAuth state token is NOT accepted as a session cookie", () => {
  const state = signState({ mode: "login", nonce: "abc", exp: Math.floor(Date.now() / 1000) + 600 });
  assert.notEqual(verifyState(state), null, "state must still verify as a state token");
  assert.equal(verifySession(state), null, "state token must never verify as a session");
});

test("a session cookie is NOT accepted as an OAuth state token", () => {
  const { value } = signSession("alice", "admin");
  assert.notEqual(verifySession(value), null, "session must still verify as a session");
  assert.equal(verifyState(value), null, "session must never verify as a state token");
});

test("the two token types produce different signatures for identical bodies", () => {
  // Domain separation must be in the MAC itself, not merely in the payload shape.
  const body = "same-body";
  assert.notEqual(hmac("hopwatch.session.v1", body), hmac("hopwatch.oauth-state.v1", body));
});

test("a session round-trips and carries sub and role", () => {
  const { value, maxAge } = signSession("bob", "viewer", 3600);
  const s = verifySession(value);
  assert.equal(s?.sub, "bob");
  assert.equal(s?.role, "viewer");
  assert.equal(maxAge, 3600);
});

test("a well-signed payload missing sub or role is rejected", () => {
  // Shape validation is defense in depth: signature alone must not make a payload a Session.
  const mk = (obj: unknown) => {
    const body = Buffer.from(JSON.stringify(obj)).toString("base64url");
    return `${body}.${hmac("hopwatch.session.v1", body)}`;
  };
  const future = Math.floor(Date.now() / 1000) + 600;
  assert.equal(verifySession(mk({ exp: future })), null, "no sub/role");
  assert.equal(verifySession(mk({ sub: "x", exp: future })), null, "no role");
  assert.equal(verifySession(mk({ role: "admin", exp: future })), null, "no sub");
  assert.equal(verifySession(mk({ sub: "", role: "admin", exp: future })), null, "empty sub");
  assert.equal(verifySession(mk({ sub: "x", role: "", exp: future })), null, "empty role");
  // A non-numeric exp must not pass the comparison by coercion.
  assert.equal(verifySession(mk({ sub: "x", role: "admin", exp: "9999999999" })), null, "string exp");
  // Sanity: the same builder with a full payload IS accepted, so these assertions mean something.
  assert.notEqual(verifySession(mk({ sub: "x", role: "admin", exp: future })), null);
});

test("expired and tampered sessions are rejected", () => {
  const { value } = signSession("carol", "admin", 300);
  // Tamper the payload: the signature no longer matches.
  const [body, sig] = value.split(".");
  const evil = Buffer.from(JSON.stringify({ sub: "carol", role: "admin", exp: 9999999999 })).toString("base64url");
  assert.equal(verifySession(`${evil}.${sig}`), null, "re-signed payload must fail");
  assert.ok(body && sig);
  // An expired-but-validly-signed session is rejected.
  const expiredBody = Buffer.from(JSON.stringify({ sub: "carol", role: "admin", exp: 1 })).toString("base64url");
  assert.equal(verifySession(`${expiredBody}.${hmac("hopwatch.session.v1", expiredBody)}`), null);
});

// ---------------------------------------------------------------------------
// Static guard: the role inside the cookie is not an authorization source.
//
// signSession stamps the role at login for server.auth.session_ttl_hours (default 30 days), and
// nothing invalidates sessions when a role changes. src/auth/rbac.ts therefore re-reads the stored
// role on every request, and deliberately fails closed for a deleted account. Any OTHER module that
// reads `session.role` silently reverts to the stale value: that is how a demoted admin kept full
// write access to every owned node (actorFor), and how the admin nav and the new-node controls kept
// showing. Comparing against the literal string "admin" has a second failure mode, it cannot see a
// CUSTOM admin role.
//
// So: only the session codec and the role resolver may touch the cookie's role.
// ---------------------------------------------------------------------------

const ROLE_SOURCE_ALLOWLIST = new Set([
  "src/auth/session.ts", // the codec: it signs and parses the field
  "src/auth/rbac.ts",    // the resolver: re-reads the DB, and falls back to the cookie only on a DB outage
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e !== "node_modules" && e !== ".next") sourceFiles(p, out);
    } else if (p.endsWith(".ts") || p.endsWith(".tsx")) {
      out.push(p);
    }
  }
  return out;
}

test("nothing outside the session codec and the role resolver reads the cookie's role", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles("src")) {
    const rel = file.split(sep).join("/");
    if (ROLE_SOURCE_ALLOWLIST.has(rel)) continue;
    const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (/\bsession\s*\??\.\s*role\b/.test(src)) offenders.push(`${rel} reads session.role`);
    if (/\.role\s*===\s*"admin"/.test(src)) offenders.push(`${rel} compares a role against the literal "admin"`);
  }
  assert.deepEqual(
    offenders,
    [],
    `use sessionAccess()/pageAccess().admin instead:\n  ${offenders.join("\n  ")}`,
  );
});
