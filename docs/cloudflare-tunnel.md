# Exposing HopWatch (and MeshView) with a Cloudflare Tunnel

A Cloudflare Tunnel publishes your self-hosted web services to the internet over an outbound-only
connection. There is no port forwarding, no static IP, and no exposing your home network: the
`cloudflared` daemon dials out to Cloudflare, and Cloudflare serves your hostnames with free TLS. It
works behind CGNAT and keeps your real IP hidden. This is how a public HopWatch map, a public
MeshView, and MeshView-world pulls can all run from a box on a home connection.

## What it does and does not cover

- **Covers (HTTP/HTTPS):** the HopWatch web UI and API, the MeshView web UI and its `/api/nodes`
  endpoint, your community site, anything that speaks HTTP. Map these as public hostnames.
- **Does NOT cover the MQTT broker (for Meshtastic gateways).** A Cloudflare Tunnel publishes
  HTTP(S) hostnames; Meshtastic firmware connects to MQTT over **plain TCP (1883)**, which a tunnel's
  public hostname cannot carry. So there is no `mqtt://your-domain:1883` a gateway can dial through
  the tunnel. Reach the broker another way:
  - **Local gateways (the usual case):** they are on the same LAN as the broker, so they just connect
    to its LAN IP:1883. No tunnel needed. (See `install-mqtt.sh` and the README's "Run your own MQTT
    broker" section.)
  - **Remote gateways:** give the broker a real TCP endpoint. Open/forward a port (use **8883 with
    TLS and a password**, not bare 1883, if it faces the internet), or put the gateway site and the
    broker on the same **VPN / Tailscale** network.
  - **Not a free-tunnel job:** public raw-TCP proxying is Cloudflare **Spectrum**, a paid add-on.
    (MQTT-over-WebSockets *can* ride an HTTP tunnel, but Meshtastic firmware does not speak it, so it
    does not help gateways.)
  The tunnel is still the right tool for everything HTTP: the HopWatch/MeshView web UIs and the
  `/api/nodes` endpoint that MeshView-world pulls.

## Prerequisites

- A domain managed by Cloudflare (the free plan is fine). Add your domain to Cloudflare and point its
  nameservers there if you have not already.
- The Linux host that runs HopWatch (web on port 3030) and/or MeshView (web on port 8081).

## Method A: dashboard-managed tunnel (recommended, token-based)

The quickest path. The ingress rules live in Cloudflare's dashboard; the host only runs the connector.

1. Go to the **Cloudflare Zero Trust** dashboard (`one.dash.cloudflare.com`) -> **Networks -> Tunnels**
   (older dashboards: **Access -> Tunnels**). Click **Create a tunnel**, choose **Cloudflared**, and
   give it a name (e.g. `home`).
2. Cloudflare shows an install command with a long token for your OS. On Debian/Ubuntu it looks like:
   ```bash
   # installs cloudflared and runs it as a systemd service bound to your tunnel
   curl -L https://pkg.cloudflare.com/cloudflared.deb -o cloudflared.deb && sudo dpkg -i cloudflared.deb
   sudo cloudflared service install <YOUR-TUNNEL-TOKEN>
   ```
   Treat that token like a password: it authenticates your tunnel. Do not commit it or share it.
3. Back in the dashboard, open the tunnel's **Public Hostname** tab and add a route per service:
   - **Subdomain** `hopwatch`, **Domain** `example.com`, **Type** `HTTP`, **URL** `localhost:3030`
   - **Subdomain** `meshview`, **Domain** `example.com`, **Type** `HTTP`, **URL** `localhost:8081`
   - (add your community site, etc., the same way)
   Cloudflare creates the DNS records automatically and terminates TLS at its edge.
4. Verify:
   ```bash
   systemctl status cloudflared          # should be active
   curl -sS https://hopwatch.example.com/readyz   # -> "ready"
   ```

## Method B: config-file tunnel (self-managed ingress)

If you prefer the ingress rules in a file on the host:

```bash
cloudflared tunnel login                       # opens a browser to authorize your domain
cloudflared tunnel create home                 # prints a TUNNEL-ID and writes a credentials json
```

Create `/etc/cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL-ID>
credentials-file: /root/.cloudflared/<TUNNEL-ID>.json
ingress:
  - hostname: hopwatch.example.com
    service: http://localhost:3030
  - hostname: meshview.example.com
    service: http://localhost:8081
  # catch-all (required, must be last)
  - service: http_status:404
```

Route DNS and run it as a service:

```bash
cloudflared tunnel route dns home hopwatch.example.com
cloudflared tunnel route dns home meshview.example.com
sudo cloudflared service install        # installs + starts the systemd unit
```

## The automated-puller gotcha (MeshView-world, uptime monitors)

Cloudflare's **Bot Fight Mode** flags traffic from datacenter/cloud networks (AWS, GCP, etc.) as
automated and challenges it. That silently breaks anything that polls your site from a cloud host,
most notably the MeshView-world collector that pulls your `/api/nodes` every few hours: your endpoint
works in a browser, but the collector gets a challenge and records zero nodes.

If a puller cannot see your data, check **Security -> Events** for its IP being "mitigated," then
allowlist it:

- **Security -> WAF -> Tools -> IP Access Rules** -> add the puller's IP with action **Allow**, scoped
  to your zone. (IP Access Rules are on the free plan and bypass Bot Fight Mode for that IP.)
- Or, if you have no reason to run Bot Fight Mode, turn it off under **Security -> Bots**.

The MeshView-world collector currently polls from `13.52.149.100` (AWS); confirm the current address
in your own Security Events before allowlisting.

## Locking down admin (optional)

To require a login in front of `/admin` without changing HopWatch, add a **Cloudflare Access**
application (Zero Trust -> Access -> Applications) for `hopwatch.example.com/admin` with an email or
one-time-PIN policy. HopWatch's own auth still applies underneath.

## Troubleshooting

- **Error 1033 / HTTP 530** on every hostname: `cloudflared` is not connected. `systemctl status
  cloudflared`, `journalctl -u cloudflared -n 50`. Usually the host lost its internet uplink or the
  service stopped; it reconnects on its own once connectivity returns.
- **502 / "bad gateway":** the tunnel connected but the origin service is down or on the wrong port.
  Check the local service (`curl localhost:3030/readyz`) and the URL in the hostname mapping.
- **One hostname 530 while others work:** that hostname has no public-hostname route, or points at a
  dead port. Re-check its mapping.
- **DNS not resolving:** the public-hostname step creates the CNAME; if you made the DNS record by
  hand, make sure it is the orange-clouded CNAME to `<TUNNEL-ID>.cfargotunnel.com`.
