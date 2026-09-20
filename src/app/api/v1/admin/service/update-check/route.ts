import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../../auth/guard.ts";
import { effectiveConfig } from "../../../../../../db/appsettings.ts";
import { appVersion } from "../../../../../../lib/version.ts";
import { isUpdateAvailable } from "../../../../../../lib/updatecheck.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Is a newer release available? Compares the running version to the latest GitHub release of the
// configured repo and lets the admin UI prompt for the existing self-update. This only READS; it
// never installs anything. The GitHub lookup is cached module-side (~1h) so opening /admin does not
// exhaust the unauthenticated API's 60 req/hr/IP budget.
let cache: { at: number; repo: string; latest: string | null; url: string | null; error?: string } | null = null;
const TTL_MS = 60 * 60 * 1000;

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const current = appVersion();
  const u = (await effectiveConfig()).server.updates;
  if (!u.enabled) return NextResponse.json({ enabled: false, current });

  const repo = String(u.github_repo || "").trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return NextResponse.json({ enabled: true, current, latest: null, update_available: false, error: "invalid github_repo (want owner/name)" });
  }

  const now = Date.now();
  if (!cache || cache.repo !== repo || now - cache.at > TTL_MS) {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { "User-Agent": "hopwatch-update-check", Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 404) cache = { at: now, repo, latest: null, url: null, error: "no releases published yet" };
      else if (!res.ok) cache = { at: now, repo, latest: null, url: null, error: `GitHub returned HTTP ${res.status}` };
      else {
        const j = (await res.json()) as { tag_name?: string; html_url?: string };
        cache = { at: now, repo, latest: String(j.tag_name ?? "").replace(/^v/i, "") || null, url: j.html_url ?? null };
      }
    } catch (e) {
      cache = { at: now, repo, latest: null, url: null, error: (e as Error).message };
    }
  }

  return NextResponse.json({
    enabled: true,
    current,
    latest: cache.latest,
    repo,
    update_available: isUpdateAvailable(cache.latest, current),
    url: cache.url,
    checked_at: new Date(cache.at).toISOString(),
    ...(cache.error ? { error: cache.error } : {}),
  });
}
