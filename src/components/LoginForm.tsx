"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const res = await fetch("/api/v1/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: form.get("username"), password: form.get("password") }),
    });
    setBusy(false);
    if (res.ok) {
      router.push("/admin/mute");
      router.refresh();
    } else {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "login failed");
    }
  }

  return (
    <form className="space-y-3" onSubmit={onSubmit}>
      <label className="block space-y-1.5">
        <span className="stat-label">Username</span>
        <input
          name="username"
          autoComplete="username"
          className="h-10 w-full rounded-md border border-line bg-raised px-3 text-base text-ink focus:border-accent focus:outline-none"
        />
      </label>
      <label className="block space-y-1.5">
        <span className="stat-label">Password</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          className="h-10 w-full rounded-md border border-line bg-raised px-3 text-base text-ink focus:border-accent focus:outline-none"
        />
      </label>
      {error && <p className="text-xs text-accent-strong">{error}</p>}
      <button className="btn btn-primary h-10 w-full" type="submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
