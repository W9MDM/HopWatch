"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

// Makes any table row with a data-href navigate on click, while leaving real controls
// (links, buttons, inputs) inside the row working normally. Paired with a cursor-pointer
// class on the row for the affordance.
export function RowLinkEnhancer() {
  const path = usePathname();
  const router = useRouter();
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || t.closest("a,button,input,select,label,textarea")) return;
      const row = t.closest("tr[data-href]");
      const href = row?.getAttribute("data-href");
      if (href) router.push(href);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [path, router]);
  return null;
}
