# vercel-xhttp-relay

A minimal **Vercel Edge Function** that relays **XHTTP** traffic to your
backend Xray/V2Ray server. Use Vercel's globally distributed edge network
(and its `vercel.com` / `*.vercel.app` SNI) as a front for your real Xray
endpoint — useful in regions where the backend host is blocked but Vercel
is reachable.

> ⚠️ **XHTTP transport only.** This relay is purpose-built for Xray's
> `xhttp` transport. It will **not** work with `WebSocket`, `gRPC`, `TCP`,
> `mKCP`, `QUIC`, or any other V2Ray/Xray transport — the Edge runtime
> doesn't support WebSocket upgrade or arbitrary TCP, and the other
> transports rely on protocol features Edge `fetch` doesn't expose.

## Disclaimer

**This repository is for education, experimentation, and personal testing
only.** It is **not** production software: there is no SLA, no security
audit, no ongoing maintenance guarantee, and no support channel.

- **Do not rely on it for production** workloads, critical infrastructure,
  or anything where availability, confidentiality, or integrity must be
  assured. You deploy and operate it **entirely at your own risk**.
- **Compliance is your responsibility.** Laws, regulations, and acceptable
  use policies (including your host's and Vercel's) vary by jurisdiction
  and service. The authors and contributors are **not** responsible for how
  you use this code or for any damages, losses, or legal consequences that
  arise from it.
- **Vercel's terms of service** apply to anything you run on their
  platform. A generic HTTP relay may violate their rules or acceptable use
  if misused; read and follow [Vercel's policies](https://vercel.com/legal)
  yourself.
- **No warranty.** The software is provided "as is", without warranty of
  any kind, express or implied. The authors accept no liability for its
  use or misuse.

If you need something production-grade, build or buy a properly engineered
solution with monitoring, hardening, legal review, and operational ownership.

---

## How It Works

```
┌──────────┐   TLS / SNI: *.vercel.app    ┌──────────────────┐    HTTP/2     ┌──────────────┐
│  Client  │ ───────────────────────────► │  Vercel Edge     │ ───────────►  │  Your Xray   │
│ (v2rayN, │   XHTTP request (POST/GET)   │  (V8 isolate,    │  XHTTP frames │  server with │
│ xray-core│                              │  streams body)   │  forwarded    │ XHTTP inbound│
└──────────┘                              └──────────────────┘               └──────────────┘
```

1. Your Xray client opens an XHTTP request to a Vercel domain
   (`your-app.vercel.app`, or any custom domain pointed at Vercel).
2. The TLS handshake uses **Vercel's certificate / SNI**, so to a censor it
   looks like ordinary traffic to a legitimate Vercel-hosted site.
3. The Edge function pipes the request body to your real Xray server
   (`TARGET_DOMAIN`) as a `ReadableStream` — no buffering — and pipes the
   upstream response back the same way.

## Why Edge Runtime?

- **True bidirectional streaming** via WebStreams (`req.body` →
  `fetch(..., { duplex: "half" })` → upstream response). First byte out as
  soon as first byte in. This matches XHTTP's chunked POST/GET model
  exactly.
- **~5–50 ms cold starts.** Edge functions run in V8 isolates, not AWS
  Lambda microVMs — roughly 10× faster to start than the equivalent
  Rust/Go serverless function.
- **Runs at every Vercel PoP globally.** Anycast routing puts your relay
  within a few ms of every client, regardless of where your origin lives.
- **No buildtime, no toolchain, no native deps.** A single ~60-line JS
  file.

## High-load tuning baked in

The handler is written for sustained throughput:

- `TARGET_DOMAIN` is read **once at cold start** and cached at module
  scope — no env lookup per request.
- URL parsing is skipped entirely — `req.url.indexOf("/", 8)` + `slice`
  extracts the path+query without allocating a `URL` object.
- Headers are filtered in a **single pass**: hop-by-hop headers
  (`connection`, `keep-alive`, `transfer-encoding`, …), Vercel telemetry
  (`x-vercel-*`), and Vercel-edge `x-forwarded-host/proto/port` are
  dropped. The client's real IP (`x-real-ip` or original
  `x-forwarded-for`) is forwarded as `x-forwarded-for`.
- `fetch(targetUrl, options)` is called directly — no extra
  `new Request(...)` allocation.
- `redirect: "manual"` keeps Vercel from chasing 3xx upstream and
  breaking the XHTTP framing.

---

## Setup & Deployment

### 1. Requirements

- A working **Xray server with XHTTP inbound** already running on a public
  host (this is your `TARGET_DOMAIN`).
- [Vercel CLI](https://vercel.com/docs/cli): `npm i -g vercel`
- A Vercel account (Pro recommended for higher bandwidth and concurrent
  invocation limits).

### 2. Configure Environment Variable

In the Vercel Dashboard → your project → **Settings → Environment
Variables**, add:

| Name            | Example                         | Description                                          |
| --------------- | ------------------------------- | ---------------------------------------------------- |
| `TARGET_DOMAIN` | `https://xray.example.com:2096` | Full origin URL of your backend Xray XHTTP endpoint. |

Notes:

- Use `https://` if your backend terminates TLS, `http://` if plain.
- Include a non-default port if needed.
- Trailing slashes are stripped automatically.

### 3. Deploy

```bash
git clone https://github.com/ramynn/vercel-xhttp-relay.git
cd vercel-xhttp-relay

vercel --prod
```

After deployment Vercel gives you a URL like `your-app.vercel.app`.

---

## Client Configuration (VLESS / Xray with XHTTP)

In your client config, point the **address** at your Vercel domain and set
**SNI / Host** to a `vercel.com`-family hostname. The `id`, `path`, and
inbound settings must match what your real Xray server expects — the relay
is transport-agnostic and just forwards bytes.

### Example VLESS share link

```
vless://UUID@vercel.com:443?encryption=none&security=tls&sni=vercel.com&type=xhttp&path=/yourpath&host=your-app.vercel.app#vercel-relay
```

### Example Xray client JSON (outbound)

```json
{
  "protocol": "vless",
  "settings": {
    "vnext": [
      {
        "address": "vercel.com",
        "port": 443,
        "users": [{ "id": "YOUR-UUID", "encryption": "none" }]
      }
    ]
  },
  "streamSettings": {
    "network": "xhttp",
    "security": "tls",
    "tlsSettings": {
      "serverName": "vercel.com",
      "allowInsecure": false
    },
    "xhttpSettings": {
      "path": "/yourpath",
      "host": "your-app.vercel.app",
      "mode": "auto"
    }
  }
}
```

### Tips

- You can use **any Vercel-fronted hostname** for SNI as long as the TLS
  handshake reaches Vercel. Custom domains pointed at Vercel work too.
- The `path` and `id` (UUID) must match the **backend Xray** XHTTP inbound,
  not this relay.
- If censorship targets `*.vercel.app` directly, attach a custom domain in
  the Vercel dashboard and use that as both `address` and `sni`.

---

## Limitations

- **XHTTP only.** WebSocket / gRPC / raw TCP / mKCP / QUIC do **not** work
  on Vercel's Edge runtime regardless of how the relay is implemented.
- **Edge per-invocation CPU budget** (~50 ms compute on Hobby, more on
  Pro). I/O wait time doesn't count, so streaming proxies stay well within
  budget — but a stuck upstream can hit the wall-clock limit.
- **Bandwidth quotas.** All traffic counts against your Vercel account's
  quota. Heavy use → upgrade to Pro/Enterprise.
- **Logging.** Vercel logs request metadata (path, IP, status). The body
  is not logged, but be aware of the trust model.

## Project Layout

```
.
├── api/index.js     # Edge function: streams request → TARGET_DOMAIN, streams response back
├── package.json     # Project metadata (no runtime deps; fetch/Headers are globals)
├── vercel.json      # Routes all paths → /api/index
└── README.md
```

## License

MIT.
