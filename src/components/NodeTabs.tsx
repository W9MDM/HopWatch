import Link from "next/link";
import { cn } from "../lib/cn.ts";

// Tab bar shared by the node overview and its reach page. Each tab is its own route (so the URL stays
// shareable), styled as an underline tab set so it reads as one node with switchable views.
type NodeTab = "overview" | "reach" | "packets";

export function NodeTabs({ nodeId, active }: { nodeId: number; active: NodeTab }) {
  const tab = (href: string, key: NodeTab, label: string) => (
    <Link
      href={href}
      className={cn(
        "-mb-px border-b-2 px-3 pb-2 pt-1 text-[13px] transition-colors",
        active === key ? "border-accent font-medium text-ink" : "border-transparent text-ink-mute hover:text-ink",
      )}
    >
      {label}
    </Link>
  );
  return (
    <div className="flex items-center gap-1 border-b border-line">
      {tab(`/nodes/${nodeId}`, "overview", "Overview")}
      {tab(`/nodes/${nodeId}/reach`, "reach", "Reach")}
      {tab(`/nodes/${nodeId}/packets`, "packets", "Packets")}
    </div>
  );
}
