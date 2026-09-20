export interface SocialLinksConfig { facebook: string; discord: string; website: string }

const cls = "flex h-7 w-7 items-center justify-center rounded-md border border-line text-ink-mute hover:bg-raised hover:text-ink";

// Facebook, Discord, and website links as icons in the header. Each renders only when its URL is
// set (admin UI). Opens in a new tab; rel=noopener so the target cannot reach window.opener.
export function SocialLinks({ links }: { links: SocialLinksConfig }) {
  const items: { key: string; href: string; label: string; icon: React.ReactNode }[] = [];
  if (links.website) items.push({ key: "website", href: links.website, label: "Website", icon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.5 3.5 6 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-6-3.5-9s1-6.5 3.5-9z" />
    </svg>
  ) });
  if (links.discord) items.push({ key: "discord", href: links.discord, label: "Discord", icon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M20 4.4A19 19 0 0 0 15.4 3l-.3.5a14 14 0 0 1 4 2 16 16 0 0 0-13.6 0 14 14 0 0 1 4-2L9.2 3A19 19 0 0 0 4.6 4.4 20 20 0 0 0 1 17.9a19 19 0 0 0 5.8 2.9l.5-.8a12 12 0 0 1-1.9-.9l.5-.4a13 13 0 0 0 11.2 0l.5.4c-.6.4-1.2.7-1.9.9l.5.8A19 19 0 0 0 23 17.9a20 20 0 0 0-3-13.5ZM8.6 15.3c-.9 0-1.7-.9-1.7-1.9s.8-1.9 1.7-1.9 1.7.9 1.7 1.9-.8 1.9-1.7 1.9Zm6.8 0c-.9 0-1.7-.9-1.7-1.9s.8-1.9 1.7-1.9 1.7.9 1.7 1.9-.8 1.9-1.7 1.9Z" />
    </svg>
  ) });
  if (links.facebook) items.push({ key: "facebook", href: links.facebook, label: "Facebook", icon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M22 12a10 10 0 1 0-11.6 9.9v-7H7.9V12h2.5V9.8c0-2.5 1.5-3.9 3.8-3.9 1.1 0 2.2.2 2.2.2v2.5h-1.3c-1.2 0-1.6.8-1.6 1.6V12h2.8l-.4 2.9h-2.4v7A10 10 0 0 0 22 12Z" />
    </svg>
  ) });
  if (items.length === 0) return null;
  return (
    <div className="flex flex-none items-center gap-1.5">
      {items.map((it) => (
        <a key={it.key} href={it.href} target="_blank" rel="noopener noreferrer" className={cls} title={it.label} aria-label={it.label}>
          {it.icon}
        </a>
      ))}
    </div>
  );
}
