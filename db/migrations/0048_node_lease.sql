-- Serialize access to the station node's TCP stream API.
--
-- The firmware's API server holds exactly ONE client. ServerAPI.cpp APIServerPort::runOnce does
-- `if (openAPI) { LOG_INFO("Force close previous TCP connection"); openAPI.reset(); }` before
-- installing a newly accepted client, so any new connection destroys the existing PhoneAPI session
-- unconditionally (only #if RAK_4631 delays it, and then by under a second before force-closing
-- anyway). HopWatch opens that port from four places in three processes: the persistent ingest RX
-- stream, every worker TX publish, the worker's channel-index config read, and admin config
-- read/write in web. Unserialized, they evict each other, and because the RX connector reconnects
-- with its backoff reset on every successful connect, the two sides ping-pong: a TX publish kills
-- the RX stream, the RX reconnect kills the TX handshake mid-dump, the TX retry kills RX again.
--
-- Processes may only coordinate through the database (Rule 5), so this is a single-row lease.
-- A holder takes it before connecting; the ingest RX connector polls it and yields (staying down,
-- without counting a reconnect) for as long as it is held. `token` scopes renew/release to the
-- holder that acquired it, and `expires_at` makes the lease self-healing if a process dies while
-- holding it.
CREATE TABLE node_lease (
  id          TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  token       CHAR(32)         NOT NULL DEFAULT '',
  holder      VARCHAR(32)      NOT NULL DEFAULT '',
  reason      VARCHAR(64)      NOT NULL DEFAULT '',
  acquired_at DATETIME(3)      NULL,
  expires_at  DATETIME(3)      NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO node_lease (id, expires_at) VALUES (1, '2000-01-01 00:00:00')
  ON DUPLICATE KEY UPDATE id = id;
