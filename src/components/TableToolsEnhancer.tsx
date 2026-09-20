"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

// Global client-side table tools: a per-table filter box + pagination for any server-rendered
// `.data` table, mounted once in the layout (like TableSortEnhancer) so every heavy page gets them
// with no per-page markup. One component owns row visibility (filter AND page), so the two never
// fight. It cooperates with TableSortEnhancer: sorting re-appends the full row set (a tbody
// childList mutation) which this observes and re-applies. Opt a table out with `data-no-paginate`
// (e.g. one that already does its own server-side filter/paging, like /nodes).
const PAGE_SIZE = 50;
const TOOLS_MIN = 8; // only enhance tables with at least this many data rows

function dataRows(tbody: HTMLTableSectionElement): HTMLTableRowElement[] {
  // Skip empty-state rows (a single colSpan cell).
  return Array.from(tbody.querySelectorAll<HTMLTableRowElement>(":scope > tr")).filter((r) => !r.querySelector("td[colspan]"));
}

function enhance(table: HTMLTableElement) {
  if (table.dataset.tooled || table.dataset.noPaginate !== undefined) return;
  const tbody = table.querySelector("tbody");
  if (!tbody || dataRows(tbody).length < TOOLS_MIN) return;
  table.dataset.tooled = "1";

  let query = "";
  let page = 0;
  // Insert the controls INSIDE the table's own container (its card), immediately around the table,
  // never as siblings of the .overflow-x-auto wrapper: that wrapper can itself be a grid/flex item
  // (e.g. the backbone page lays cards out in a 2-column grid), so a sibling insert dropped the
  // filter box and pager into the parent grid as stray items and scattered the whole layout. The
  // controls are left-aligned (not stretched) so a wide, horizontally-scrolling table does not push
  // the Next button off to the right.
  const host = table.parentElement;
  if (!host) { table.dataset.tooled = ""; return; }

  // Filter box above the table.
  const tools = document.createElement("div");
  tools.className = "hw-tabletools mb-2 flex items-center gap-2";
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Filter rows...";
  input.className = "h-8 w-56 rounded-md border border-line bg-raised px-3 text-[12px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none";
  tools.append(input);
  host.insertBefore(tools, table);

  // Pager below the table.
  const bar = document.createElement("div");
  bar.className = "hw-tablepager flex flex-wrap items-center gap-3 pt-2 text-[12px] text-ink-mute";
  const label = document.createElement("span");
  const nav = document.createElement("div");
  nav.className = "flex items-center gap-2";
  const prev = document.createElement("button");
  const next = document.createElement("button");
  const pageLbl = document.createElement("span");
  pageLbl.className = "tabular-nums";
  for (const b of [prev, next]) { b.type = "button"; b.className = "btn btn-outline h-7 px-2 text-[12px]"; }
  prev.textContent = "Prev";
  next.textContent = "Next";
  nav.append(prev, pageLbl, next);
  bar.append(label, nav);
  host.insertBefore(bar, table.nextSibling);

  const apply = () => {
    const rs = dataRows(tbody);
    const q = query.trim().toLowerCase();
    const matched = q ? rs.filter((r) => (r.textContent ?? "").toLowerCase().includes(q)) : rs;
    const pc = Math.max(1, Math.ceil(matched.length / PAGE_SIZE));
    page = Math.min(Math.max(0, page), pc - 1);
    const start = page * PAGE_SIZE;
    const end = start + PAGE_SIZE;
    const inPage = new Set(matched.slice(start, end));
    for (const r of rs) r.style.display = inPage.has(r) ? "" : "none";
    label.textContent = `Showing ${matched.length ? start + 1 : 0}-${Math.min(end, matched.length)} of ${matched.length}${q ? ` (filtered from ${rs.length})` : ""}`;
    pageLbl.textContent = `Page ${page + 1} / ${pc}`;
    prev.disabled = page <= 0;
    next.disabled = page >= pc - 1;
    prev.style.opacity = prev.disabled ? "0.4" : "";
    next.style.opacity = next.disabled ? "0.4" : "";
    // Hide the pager entirely when there is nothing to page through.
    bar.style.display = matched.length > PAGE_SIZE ? "" : "none";
  };

  input.addEventListener("input", () => { query = input.value; page = 0; apply(); });
  prev.addEventListener("click", () => { page -= 1; apply(); });
  next.addEventListener("click", () => { page += 1; apply(); });
  // Rows reordered/replaced (sort, live refresh): jump to page 1 and re-apply. childList only, so
  // our own display toggles (style) never re-trigger this.
  new MutationObserver(() => { page = 0; apply(); }).observe(tbody, { childList: true });
  apply();
}

export function TableToolsEnhancer() {
  const path = usePathname();
  useEffect(() => {
    const wire = () => document.querySelectorAll<HTMLTableElement>("table.data").forEach(enhance);
    wire();
    const main = document.querySelector("main");
    const mo = main ? new MutationObserver(() => wire()) : null;
    if (main && mo) mo.observe(main, { childList: true, subtree: true });
    return () => mo?.disconnect();
  }, [path]);
  return null;
}
