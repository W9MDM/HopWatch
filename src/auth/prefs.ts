import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "./session.ts";
import { getUserPrefs, type UserPrefs } from "./users.ts";

// Server-side read of the current user's saved preferences (profile page). Empty for
// anonymous visitors. Used by pages to seed default filters.
export async function currentUserPrefs(): Promise<UserPrefs> {
  const jar = await cookies();
  const session = verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!session) return {};
  try {
    return await getUserPrefs(session.sub);
  } catch {
    return {};
  }
}

// Resolve a filter value from a URL param + the user's default. An explicit "all" sentinel
// means "show everything" (overrides the default); an absent param falls back to the default.
export function resolveDefault(param: string | undefined, fallback: string | undefined): string | undefined {
  if (param === "all") return undefined;
  return param ?? fallback ?? undefined;
}

// For GET-form pages: the form always submits the field, so an empty string means the user
// explicitly chose "all" (overrides the default), while an absent param (first visit / a bare
// link) falls back to the saved default.
export function resolveFormDefault(param: string | undefined, fallback: string | undefined): string | undefined {
  if (param === undefined) return fallback ?? undefined;
  return param || undefined;
}
