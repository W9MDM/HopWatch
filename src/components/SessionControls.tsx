"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { cn } from "../lib/cn.ts";

// Header auth control. Signed in: the username is a dropdown (Profile, Sign out). Admin
// settings live under the System nav group, not here. Anonymous: a read-only badge + sign in.
export function SessionControls({ admin, user, build }: { admin: boolean; user: string | null; build?: string }) {
  const router = useRouter();

  async function logout() {
    await fetch("/api/v1/admin/logout", { method: "POST" });
    router.push("/");
    router.refresh();
  }

  if (!user) {
    return (
      <div className="flex items-center gap-2">
        <span className="pill pill-off">read only</span>
        <Link href="/admin/login" className="text-[11px] text-ink-mute hover:text-ink">sign in</Link>
      </div>
    );
  }

  const itemCls =
    "block w-full cursor-pointer rounded-md px-3 py-1.5 text-left text-[13px] text-ink-mute outline-none hover:bg-raised hover:text-ink data-[highlighted]:bg-raised data-[highlighted]:text-ink";

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className={cn("pill pill-on inline-flex items-center gap-1 outline-none")}>
        {admin ? `admin: ${user}` : user}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          sideOffset={6}
          align="end"
          className="z-50 min-w-40 rounded-lg border border-line bg-surface p-1 shadow-xl shadow-black/50"
        >
          <DropdownMenu.Item asChild>
            <Link href="/profile" className={itemCls}>Profile</Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item className={itemCls} onSelect={() => { void logout(); }}>Sign out</DropdownMenu.Item>
          {build && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
              <div className="px-3 py-1 text-[11px] text-ink-faint" title="Deployed version and git commit">{build}</div>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
