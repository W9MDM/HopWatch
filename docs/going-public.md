# Going public: making your mesh dashboards and broker reachable

This guide takes you from a working local install to a public setup: a web dashboard anyone can
visit, and (optionally) an MQTT broker that remote Meshtastic gateways can reach. It assumes you can
follow copy-paste commands on a Debian/Ubuntu Linux box; no prior sysadmin experience required. Read
top to bottom; skip the parts you do not need.

There are two very different problems, and they are solved differently:

| What you are exposing | Protocol | How you expose it |
| --- | --- | --- |
| HopWatch / MeshView web UI + `/api/nodes` | HTTPS | Cloudflare Tunnel (easiest) **or** nginx reverse proxy |
| The MQTT broker for remote gateways | plain TCP (1883/8883) | public-IP broker with TLS, nginx stream proxy, or a VPS relay |

If all your gateways are on your own LAN (the common case), you do **not** need to expose MQTT at
all: gateways talk to the broker on the local network, and you only expose the web UI.

---

## 0. Before you start

- A Linux host running your stack. Note the local ports: HopWatch web is **3030**, MeshView web is
  **8081**, a Mosquitto broker is **1883** (and **8883** for TLS).
- A domain name. For the Cloudflare Tunnel path, the domain must be on Cloudflare (free plan is fine).
- Shell access with `sudo`.

Confirm the services answer locally first (nothing below works until these do):

```bash
curl -sS http://localhost:3030/readyz      # HopWatch -> "ready"
curl -sS http://localhost:8081/api/nodes | head -c 80   # MeshView -> JSON (if you run it)
```

---

## 1. Expose the web UI

### Option A: Cloudflare Tunnel (recommended, no port forwarding)

Best for home connections, CGNAT, or anyone who does not want to open ports. Free TLS, hides your IP.
Full step-by-step is in [`cloudflare-tunnel.md`](cloudflare-tunnel.md). The short version:

1. Cloudflare Zero Trust dashboard -> **Networks -> Tunnels -> Create a tunnel -> Cloudflared**, name it.
2. Run the install command it gives you on the host (installs `cloudflared` as a service with a token).
3. Add **Public Hostnames**: `hopwatch.example.com` -> `HTTP` `localhost:3030`, `meshview.example.com`
   -> `HTTP` `localhost:8081`. Cloudflare creates DNS + TLS automatically.
4. Visit `https://hopwatch.example.com`.

Watch out for **Bot Fight Mode** blocking automated pullers (e.g. MeshView-world) - see the tunnel
doc's gotcha section.

### Option B: nginx reverse proxy (if you have a public IP / can port-forward)

Use this if you prefer to run your own edge with Let's Encrypt instead of Cloudflare. You need a
public IP (or a forwarded port 80/443) and your domain's DNS pointing at it.

```bash
sudo apt-get update && sudo apt-get install -y nginx
# Let's Encrypt via the nginx plugin (needs port 80 reachable from the internet):
sudo apt-get install -y certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/hopwatch` (WebSocket upgrade headers matter: the live map uses SSE
and the UI uses long-lived connections):

```nginx
server {
    listen 80;
    server_name hopwatch.example.com;

    location / {
        proxy_pass http://127.0.0.1:3030;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
        proxy_read_timeout 1h;           # keep SSE/live streams open
        proxy_buffering off;             # stream events immediately
    }
}
```

Enable it and get a certificate (certbot rewrites the file to add the 443 TLS server block):

```bash
sudo ln -s /etc/nginx/sites-available/hopwatch /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d hopwatch.example.com   # answer the prompts; choose redirect to HTTPS
```

Repeat the server block (and `certbot -d`) for `meshview.example.com` -> `127.0.0.1:8081`. Open ports
80 and 443 in your firewall (`sudo ufw allow 80,443/tcp`).

---

## 2. Expose the MQTT broker (only if you have remote gateways)

A Cloudflare Tunnel **cannot** do this: it serves HTTP, and Meshtastic gateways speak plain TCP MQTT.
You have three honest paths depending on your network.

### Do you actually need it?

If every gateway is on the same LAN as the broker, point each gateway at the broker's **LAN IP:1883**
and stop here. You only need the rest of this section for gateways at other sites reaching your broker
over the internet.

### Path 2A: you have a public IP (or can port-forward) -> Mosquitto TLS on 8883

The broker handles TLS itself; you do not need nginx for this. Start from the installer:

```bash
sudo bash scripts/install-mqtt.sh          # sets up the broker + a user/password (see README)
```

Get a certificate for the broker's hostname. If port 80 is reachable, the easy way:

```bash
sudo apt-get install -y certbot
sudo certbot certonly --standalone -d mqtt.example.com    # writes /etc/letsencrypt/live/mqtt.example.com/
sudo usermod -aG ssl-cert mosquitto 2>/dev/null || true
```

Add a TLS listener. Append to `/etc/mosquitto/conf.d/meshtastic.conf`:

```
listener 8883
certfile /etc/letsencrypt/live/mqtt.example.com/fullchain.pem
keyfile  /etc/letsencrypt/live/mqtt.example.com/privkey.pem
```

```bash
sudo systemctl restart mosquitto
sudo ufw allow 8883/tcp      # open ONLY 8883 (TLS), keep 1883 to the LAN
```

On each remote gateway (Meshtastic app -> Config -> MQTT): Address `mqtt.example.com:8883`, the
username/password you set, and turn **TLS / Encryption ON**. Keep "Map reporting" and channel
"Uplink enabled" on so neighbor/position data flows. Certbot auto-renews; `mosquitto` picks up renewed
certs on restart (add a deploy hook or a weekly `systemctl restart mosquitto` if you want zero-touch).

### Path 2B: nginx (or HAProxy) stream TLS proxy

Equivalent to 2A but with nginx terminating TLS in front of a plaintext broker. Useful if you already
run nginx as your edge. Needs the stream module (ships with the `nginx` package).

Add to `/etc/nginx/nginx.conf` (the `stream {}` block is a top-level sibling of `http {}`):

```nginx
stream {
    server {
        listen 8883 ssl;
        ssl_certificate     /etc/letsencrypt/live/mqtt.example.com/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/mqtt.example.com/privkey.pem;
        proxy_pass 127.0.0.1:1883;     # the local Mosquitto listener
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
sudo ufw allow 8883/tcp
```

Gateways connect exactly as in 2A (`mqtt.example.com:8883`, TLS on). Mosquitto still enforces the
username/password; nginx only adds the TLS front.

### Path 2C: behind CGNAT / no public IP -> run the broker on a small VPS

If you cannot open a port (the same reason you used a Cloudflare Tunnel for the web), neither 2A nor
2B can accept inbound connections. The clean fix is to put the broker where it *is* publicly
reachable: a cheap VPS ($5/mo) with a public IP.

1. On the VPS: `sudo bash scripts/install-mqtt.sh` and set up TLS as in 2A (it has a public IP, so
   certbot `--standalone` just works).
2. Point all gateways (local and remote) at the VPS: `mqtt.example.com:8883`.
3. Point your HopWatch/MeshView at the VPS broker: in HopWatch, `/admin -> Settings -> MQTT brokers`,
   host `mqtt.example.com`, port `8883`, TLS on, topic `msh/#`. Your dashboard host pulls from the
   VPS; it no longer needs the broker local.

(Cloudflare **Spectrum** can proxy raw TCP publicly, but it is a paid add-on; the VPS is cheaper and
simpler for a single broker.)

---

## 3. Verify end to end

```bash
# Web (from any machine):
curl -sS https://hopwatch.example.com/readyz           # "ready"
# MQTT TLS (from a machine that is NOT on your LAN, to prove it is public):
mosquitto_sub -h mqtt.example.com -p 8883 --capath /etc/ssl/certs \
  -u meshtastic -P '<password>' -t 'msh/#' -v           # should stream live packets
```

On the dashboard, within a few minutes you should see nodes, and (because you run your own broker)
neighbor links on the live map. If MeshView-world or another external site pulls you, give it one
poll cycle and check that it stops showing zero.

---

## 4. Troubleshooting

- **Web 1033 / 530 (Cloudflare):** `cloudflared` is not connected. `systemctl status cloudflared`.
- **Web 502 (nginx):** the app is down or on the wrong port. `curl localhost:3030/readyz`.
- **Gateway will not connect over TLS:** usually a cert hostname mismatch (the gateway must use the
  exact name on the cert, e.g. `mqtt.example.com`, not an IP) or a clock/CA issue on the node. Test
  from a laptop with `mosquitto_sub` first to isolate the broker from the gateway.
- **Broker gets no traffic:** the gateway has MQTT disabled, the channel's "Uplink enabled" is off, or
  the root topic differs. Subscribe with `mosquitto_sub ... -t '#' -v` to see whether anything arrives
  at all.
- **No neighbors on the map:** you are reading from the public broker, not your own, or gateways do
  not have map reporting / uplink enabled. See the README's "Run your own MQTT broker" section.
