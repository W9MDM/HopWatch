"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

// Makes every server-rendered `.data` table sortable by clicking a column header, with no
// per-table markup changes. Click toggles asc/desc; sorting is numeric when the column's
// cells look numeric (strips commas/units), otherwise lexical. Re-runs on navigation and as
// content streams in. Empty-state rows (a single colSpan cell) are left in place.
function numeric(s: string): number {
  const m = s.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
}

function sortBy(table: HTMLTableElement, idx: number, th: HTMLTableCellElement) {
  const tbody = table.querySelector("tbody");
  if (!tbody) return;
  const rows = Array.from(tbody.querySelectorAll(":scope > tr")).filter((r) => !r.querySelector("td[colspan]"));
  if (rows.length < 2) return;

  const dir = th.getAttribute("data-sort-dir") === "asc" ? "desc" : "asc";
  table.querySelectorAll("thead th").forEach((h) => {
    h.removeAttribute("data-sort-dir");
    h.querySelector(".sort-caret")?.remove();
  });
  th.setAttribute("data-sort-dir", dir);
  const caret = document.createElement("span");
  caret.className = "sort-caret";
  caret.textContent = dir === "asc" ? " ▲" : " ▼";
  caret.style.opacity = "0.6";
  th.appendChild(caret);

  // A cell may carry an explicit numeric sort key via data-sort (e.g. a timestamp), so
  // relative-age columns like "45s"/"2h"/"3d" sort chronologically instead of by leading digit.
  const cellOf = (r: Element) => r.children[idx] as HTMLElement | undefined;
  const key = (r: Element) => {
    const c = cellOf(r);
    const ds = c?.getAttribute("data-sort");
    if (ds != null && ds !== "" && Number.isFinite(parseFloat(ds))) return { n: parseFloat(ds), s: ds, sortKey: true };
    const t = (c?.textContent ?? "").trim();
    return { n: numeric(t), s: t, sortKey: false };
  };
  rows.sort((a, b) => {
    const ka = key(a), kb = key(b);
    let cmp: number;
    if (ka.sortKey && kb.sortKey) cmp = ka.n - kb.n;
    else if (Number.isFinite(ka.n) && Number.isFinite(kb.n) && /\d/.test(ka.s) && /\d/.test(kb.s)) cmp = ka.n - kb.n;
    else cmp = ka.s.localeCompare(kb.s, undefined, { numeric: true });
    return dir === "asc" ? cmp : -cmp;
  });
  for (const r of rows) tbody.appendChild(r);
}

function enhance(table: HTMLTableElement) {
  if (table.dataset.sortable) return;
  table.dataset.sortable = "1";
  table.querySelectorAll<HTMLTableCellElement>("thead th").forEach((th, idx) => {
    if (!th.textContent?.trim()) return; // skip action/empty columns
    th.style.cursor = "pointer";
    th.style.userSelect = "none";
    if (!th.title) th.title = "Sort by this column";
    th.addEventListener("click", () => sortBy(table, idx, th));
  });
}

export function TableSortEnhancer() {
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
