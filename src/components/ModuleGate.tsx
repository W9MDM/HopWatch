import Link from "next/link";
import type { ReactNode } from "react";
import { pageAccess } from "../auth/rbac.ts";

function Restricted() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="eyebrow justify-center"><span className="eyebrow-bar" />Access restricted</h1>
      <p className="mt-3 text-[13px] text-ink-mute">This section is not available for your access level.</p>
      <Link className="btn btn-primary mt-4 h-9 px-4 text-[13px]" href="/admin/login">Sign in</Link>
    </div>
  );
}

// Server-side page guard. Wrap a page's content; if the viewer's role does not grant the
// module, the content is replaced with an access-restricted notice (hard block, not just
// hidden from nav). Admin sessions pass everything.
export async function ModuleGate({ module, children }: { module: string; children: ReactNode }) {
  const acc = await pageAccess();
  return acc.admin || acc.modules.has(module) ? <>{children}</> : <Restricted />;
}

// Early-return helper for pages: `const denied = await moduleDenied("packets"); if (denied) return denied;`
// Returns the restricted notice (blocking data fetch) or null when access is granted.
export async function moduleDenied(module: string): Promise<ReactNode | null> {
  const acc = await pageAccess();
  return acc.admin || acc.modules.has(module) ? null : <Restricted />;
}
