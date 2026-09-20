import Link from "next/link";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "../../../auth/session.ts";
import { sessionAccess } from "../../../auth/rbac.ts";
import { effectiveConfig } from "../../../db/appsettings.ts";
import { MODULES } from "../../../auth/modules.ts";
import { DbError } from "../../../components/DbError.tsx";
import { RolesManager, type Role } from "../../../components/RolesManager.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminRolesPage() {
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

  let rbac;
  try {
    rbac = (await effectiveConfig()).rbac;
  } catch (e) {
    return <DbError error={e} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="eyebrow"><span className="eyebrow-bar" />Roles &amp; access</h1>
          <p className="mt-1 text-[13px] text-ink-faint">
            Each role grants a set of modules. Anonymous visitors get the anonymous role; API tokens get the default token role;
            signed-in non-admins (including Discord logins) get the member role; a signed-in admin session always has full access.
          </p>
        </div>
        <span className="text-[11px] text-ink-faint">signed in as {session.sub}</span>
      </div>
      <RolesManager
        initialRoles={rbac.roles as unknown as Role[]}
        anonymousRole={rbac.anonymous_role}
        tokenDefaultRole={rbac.token_default_role}
        memberRole={rbac.member_role}
        modules={MODULES}
      />
    </div>
  );
}
