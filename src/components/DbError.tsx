export function DbError({ error }: { error: unknown }) {
  // Log the detail to the server; never render internal DB/SQL text to the (possibly
  // anonymous) client.
  console.error(`[db] ${error instanceof Error ? error.message : String(error)}`);
  return (
    <div className="card border-accent/40">
      <h2 className="eyebrow mb-2">
        <span className="eyebrow-bar" />
        Database unavailable
      </h2>
      <p className="text-[13px] text-ink-mute">
        HopWatch could not read from MySQL. Confirm the database is running and migrated
        (<span className="mono">npm run migrate</span>), then reload. Details are in the server log.
      </p>
    </div>
  );
}
