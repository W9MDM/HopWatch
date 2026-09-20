"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MODULES } from "../auth/modules.ts";
import { cn } from "../lib/cn.ts";

interface NodeHit { id: number; name: string | null; short: string | null; role: string | null; is_gateway: number }
interface Cmd { label: string; path: string }
type Item = { kind: "page"; label: string; path: string } | { kind: "node"; hit: NodeHit };

const fmtId = (n: number) => "!" + (n >>> 0).toString(16).padStart(8, "0");

// Global search + command palette (Cmd/Ctrl+K). Live node search plus jump-to-page commands,
// filtered to the modules this role can see (mirrors the nav).
export function CommandPalette({ allowed, admin }: { allowed: string[]; admin: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [nodes, setNodes] = useState<NodeHit[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [isMac, setIsMac] = useState(false);

  useEffect(() => { try { setIsMac(/mac/i.test(navigator.platform)); } catch { /* ignore */ } }, []);

  // Page commands from the module registry, access-filtered like the nav.
  const allowSet = new Set(admin ? MODULES.map((m) => m.key) : allowed);
  const pageCmds: Cmd[] = MODULES
    .filter((m) => m.key !== "api" && allowSet.has(m.key))
    .map((m) => ({ label: m.label, path: m.key === "admin" ? "/admin/settings" : m.paths[0]! }));
  pageCmds.push({ label: "Profile", path: "/profile" });

  const matchedPages = q.trim()
    ? pageCmds.filter((c) => c.label.toLowerCase().includes(q.trim().toLowerCase()))
    : pageCmds;
  const items: Item[] = [
    ...matchedPages.map((c) => ({ kind: "page" as const, label: c.label, path: c.path })),
    ...nodes.map((h) => ({ kind: "node" as const, hit: h })),
  ];

  // Toggle on Cmd/Ctrl+K anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Focus + reset when opened.
  useEffect(() => {
    if (open) { setActive(0); setTimeout(() => inputRef.current?.focus(), 0); }
    else { setQ(""); setNodes([]); }
  }, [open]);

  // Debounced node search.
  useEffect(() => {
    const term = q.trim();
    if (!term) { setNodes([]); return; }
    const t = setTimeout(() => {
      fetch(`/api/v1/search?q=${encodeURIComponent(term)}`)
        .then((r) => (r.ok ? r.json() : { nodes: [] }))
        .then((d) => setNodes(d.nodes ?? []))
        .catch(() => setNodes([]));
    }, 160);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => { setActive(0); }, [q]);

  const go = useCallback((it: Item | undefined) => {
    if (!it) return;
    setOpen(false);
    router.push(it.kind === "page" ? it.path : `/nodes/${it.hit.id}`);
  }, [router]);

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(items.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); go(items[active]); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 flex-none items-center gap-2 rounded-md border border-line bg-raised px-2 text-[13px] text-ink-faint hover:border-accent hover:text-ink sm:px-3"
        aria-label="Search or jump to"
      >
        {/* Icon-only on phones so the header fits; label + shortcut return at sm+. */}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
        <span className="hidden sm:inline">Search…</span>
        <kbd className="hidden rounded border border-line px-1 text-[10px] text-ink-faint sm:inline">{isMac ? "⌘" : "Ctrl"} K</kbd>
      </button>

      {open && (
        <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 pt-[12vh]" onClick={() => setOpen(false)}>
          <div
            className="w-full max-w-xl overflow-hidden rounded-xl border border-line bg-surface shadow-2xl shadow-black/60"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onInputKey}
              placeholder="Search nodes or jump to a page…"
              className="w-full border-b border-line bg-transparent px-4 py-3 text-[14px] text-ink placeholder:text-ink-faint focus:outline-none"
            />
            <div className="max-h-[50vh] overflow-y-auto p-1">
              {items.length === 0 && <div className="px-3 py-6 text-center text-[13px] text-ink-faint">No matches.</div>}
              {matchedPages.length > 0 && <div className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-ink-faint">Go to</div>}
              {items.map((it, i) => {
                const label = it.kind === "page" ? it.label : (it.hit.name || it.hit.short || fmtId(it.hit.id));
                const isFirstNode = it.kind === "node" && (i === 0 || items[i - 1]!.kind === "page");
                return (
                  <div key={it.kind === "page" ? `p:${it.path}` : `n:${it.hit.id}`}>
                    {isFirstNode && <div className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-ink-faint">Nodes</div>}
                    <button
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      onClick={() => go(it)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px]",
                        i === active ? "bg-raised text-ink" : "text-ink-mute",
                      )}
                    >
                      {it.kind === "node" && <span className="mono text-[11px] text-ink-faint">{fmtId(it.hit.id)}</span>}
                      <span className="truncate">{label}</span>
                      {it.kind === "node" && it.hit.is_gateway ? <span className="ml-auto text-[10px] text-accent-strong">gateway</span> : null}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
