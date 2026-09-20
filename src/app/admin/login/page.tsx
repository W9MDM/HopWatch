import { LoginForm } from "../../../components/LoginForm.tsx";
import { effectiveConfig } from "../../../db/appsettings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

const ERRORS: Record<string, string> = {
  discord_unlinked: "That Discord account is not linked yet. Sign in with your password below, then link Discord under Settings.",
  discord_disabled: "Discord login is not enabled.",
  discord_state: "Discord login expired or was tampered with. Please try again.",
  discord_failed: "Discord login failed. Please try again.",
  admin_required: "Admin sign-in required to link Discord.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const err = (Array.isArray(sp.error) ? sp.error[0] : sp.error) ?? "";

  let discordEnabled = false;
  try { discordEnabled = (await effectiveConfig()).server.auth.discord.enabled; } catch { /* default off */ }

  return (
    <div className="mx-auto max-w-sm py-16">
      <h1 className="eyebrow mb-4">
        <span className="eyebrow-bar" />
        Sign in
      </h1>
      {err && (
        <div className="mb-3 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-[13px] text-accent-strong">
          {ERRORS[err] ?? "Sign-in error."}
        </div>
      )}
      <div className="card space-y-4">
        {discordEnabled && (
          <>
            <a href="/api/v1/auth/discord?mode=login" className="btn btn-primary flex h-10 w-full items-center justify-center gap-2 text-[13px]" style={{ background: "#5865F2" }}>
              Continue with Discord
            </a>
            <div className="flex items-center gap-2 text-[11px] text-ink-faint">
              <span className="h-px flex-1 bg-line" /> or password <span className="h-px flex-1 bg-line" />
            </div>
          </>
        )}
        <LoginForm />
      </div>
      <p className="mt-3 text-[11px] text-ink-faint">
        Anonymous access is read-only per your role settings. Sign in for admin and transmit features.
      </p>
    </div>
  );
}
