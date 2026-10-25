# Failover Egress (dsh-proxy-failover)

> **One-line summary (≤120 chars):** Fixes web_fetch under Clash/Mihomo TUN fake-ip and fails over to direct in the same request when the proxy stops.

| Field | Value |
| --- | --- |
| Package | `dsh-proxy-failover` |
| Version | 0.1.0 |
| Category | `browser` (Browser & Fetching, where web_fetch entries sit); alternates: `tools`, `dev` |
| Tags | `web-fetch` `proxy` `clash` `mihomo` `fake-ip` `tun` `failover` `loopback-relay` `network` |
| Compatibility | DSH `>=0.2.0-rc.2` or `>=0.2.1-rc.2`; Node `^22.19.0` or `>=24`; Linux / Windows / macOS |
| License | MIT |
| Repository | `https://github.com/PILIHU2022/dsh-proxy-failover` |
| Market page | Not generated yet — [PR #9255](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/9255) is pending; the page becomes `https://awesome-dsh-plugin.com/p/PILIHU2022/dsh-proxy-failover/` after merge |
| Entry | Bundle patch inserts row id `proxy-failover`, package `dsh-proxy-failover` |

## The problem

With Mihomo / Clash in TUN mode and fake-ip enabled, DSH's built-in `web_fetch` fails outright:

```text
URL hostname "raw.githubusercontent.com" resolves to a non-public IP address
```

The usual workaround — a plugin such as [`dsh-web-fetch-proxy`](https://github.com/1499501762/dsh-web-fetch-proxy) — points `web_fetch` at the real local proxy (for example `http://127.0.0.1:7890`). Fetching recovers, but **as soon as the proxy is closed**, with no DSH config change and no restart, model requests get stuck retrying until the whole turn breaks.

## Why this exists

[`dsh-web-fetch-proxy`](https://github.com/1499501762/dsh-web-fetch-proxy) fixes fake-ip only: it points `web_fetch` at the real local proxy, and that process-wide route keeps pointing at a dead port once the proxy is closed. This plugin is a superset; the extra parts are:

- a loopback-only relay as the global route, so the real proxy's lifetime no longer decides whether a request succeeds;
- a direct connection inside the **same request** when the proxy is closed, with OS and c-ares DNS resolution racing on the direct path, so model calls do not retry against a dead port;
- a background health probe that switches back when the proxy returns or starts after DSH.

Both install a process-wide route and their semantics override each other, so use one: keep this plugin and disable `dsh-web-fetch-proxy`.

## Root cause

Two things stack up:

1. **fake-ip.** In TUN mode, DNS answers every hostname with a synthetic address (`198.18.0.22`, `fdfe:dcba:9876::ed`, …). `web_fetch` resolves locally first, then checks every answer against the public-address rules; one bad answer rejects the whole request before a connection is even attempted.
2. **A process-wide proxy route outlives the proxy process.** `@deepseek-ai/dsh-http-proxy` installs a **process-wide** proxy policy into undici's global dispatcher, and `web_fetch` skips its local DNS check precisely because `proxyRouteFor()` reports "proxied". Install the real proxy address there and the route stays after the proxy is gone, so **every** outbound request — model API included — keeps dialing a dead port, fails, is retried by `dsh-llm-retry`, fails again, and breaks the turn.

Put another way: the "proxy route" `web_fetch` needs and the "connect directly once the proxy is gone" behaviour the model needs are the same global switch. Hard-wiring the real proxy forces a choice between them.

## What this plugin does

Instead of installing the real proxy as the global route, the plugin starts a small **loopback-only HTTP relay** and installs *that* as the process-wide route. The relay decides per request:

```text
                 ┌──────────────────────────────┐
   model API ────┤                              ├── upstream proxy (Mihomo :7890) → network
   web_fetch ────┤   relay 127.0.0.1:<random>   │
   MCP / search ─┤                              ├── direct (when upstream is gone, same request)
                 └──────────────────────────────┘
```

- **Upstream available:** tunnel / forward to the real proxy. `web_fetch` still sees a `proxied` route, the proxy resolves the hostname, and fake-ip is bypassed exactly as before.
- **Upstream closed:** when the dial fails, the relay **falls back to a direct connection inside the same request**, so model calls need no retry; the upstream is marked down so later requests stop dialing it.
- **Proxy comes back:** a health loop (default every 1.5 s) sees the port recover and switches back automatically.
- **Proxy starts after DSH:** the same health loop takes it over; no DSH restart needed.
- **Connections stay up:** clients talk to an always-on relay, so the proxy's lifetime only affects the relay→upstream leg. Established bidirectional tunnels are not actively torn down by a plugin reload or relay shutdown.

Discovery order for the upstream: explicit config → `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` (both cases) → `mixed-port` in Clash / Mihomo / Clash Verge config → well-known ports. Environment variables and Clash config are trusted; ports found by probing must also pass a `CONNECT` handshake, so an unrelated service that happens to occupy 7890 is not mistaken for a proxy.

## Install

Pick one (`--profile web` should match your profile):

```bash
# GitHub source (the only remote install today)
dsh plugin --profile web add github:PILIHU2022/dsh-proxy-failover

# Local directory (development)
dsh plugin --profile web add link:/home/Projects/dsh-plugins/dsh-proxy-failover
```

The package is not published on npm and there is no prebuilt tarball on a GitHub Release, so there is no install command using the package name or a `.tgz`. Publishing is optional and does not affect catalog listing; if it happens, `dsh plugin --profile web add dsh-proxy-failover` becomes available.

The bundle patch then inserts one row:

```yaml
- insert:
    - id: proxy-failover
      name: dsh-proxy-failover
      config:
        proxy: auto
        noProxy: ""
```

After updating the plugin's code, re-enable that row (or restart DSH) to load it.

> **Use it instead of [`dsh-web-fetch-proxy`](https://github.com/1499501762/dsh-web-fetch-proxy), not alongside it.** Both install a process-wide route and their semantics override each other. This plugin is a functional superset — it fixes fake-ip *and* the dead-proxy retry storm. Keep this one and **disable `dsh-web-fetch-proxy`**.

## Configuration

Set under the row's `config` in `cordis.patch.yml` (deployment-level), or hot-edit `proxy` / `noProxy` through the `proxy-failover` settings namespace.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` means no-op; the host's existing routing is left untouched |
| `proxy` | `auto` | `auto` discovers; `off` / `none` / `direct` force direct; or pin a URL such as `http://127.0.0.1:7890` |
| `noProxy` | `""` | Appended to `no_proxy`, comma-separated; loopback always bypasses |
| `probeIntervalMs` | `1500` | Upstream health / rediscovery interval (code default) |
| `probeTimeoutMs` | `400` | TCP probe timeout per candidate port |
| `connectTimeoutMs` | `10000` | Timeout for relay→upstream and relay→target connects |
| `handshakeTimeoutMs` | `10000` | Upstream `CONNECT` handshake timeout |
| `resolveTimeoutMs` | `5000` | Direct-path DNS budget (OS and c-ares run in parallel) |
| `listenPort` | `0` | Relay port; `0` picks a random port and always binds `127.0.0.1` |
| `candidatePorts` | `7890, 7897, 7891, 7899, 10809, 10808, 1080, 2080, 20171, 8889` | Ports to probe |

Every numeric field is clamped to a safe range; invalid values fall back to the default.

## Status and troubleshooting

Read-only status endpoint (loopback only, `GET`):

```bash
curl -s http://127.0.0.1:3080/proxy-failover/status | jq
```

It answers `{ "ok": true, "value": { ... } }`; the main fields inside `value`:

```json
{
  "ok": true,
  "value": {
    "installed": true,
    "plugin": "dsh-proxy-failover",
    "routed": true,
    "relay": {
      "listen": "http://127.0.0.1:43957",
      "requests": 42,
      "fallbacks": 1,
      "upstream": { "url": "http://127.0.0.1:7890", "source": "port-probe:7890" },
      "upstreamUp": false,
      "lastError": "upstream connect failed: connect ECONNREFUSED 127.0.0.1:7890",
      "tunnels": { "active": 2, "closedOnProxyLoss": 0 },
      "dns": { "fallbacks": 1, "failures": 0, "lastMs": 12, "lastSource": "os" }
    },
    "proxy": { "proxy": "auto", "noProxy": "" },
    "candidates": [{ "url": "http://127.0.0.1:7890", "source": "port-probe:7890", "trusted": false }]
  }
}
```

- `routed: true` — `proxyRouteFor()` really points at this relay, so `web_fetch` skips its local DNS check.
- `upstreamUp: false` with `fallbacks > 0` — the proxy is closed and the latest requests went direct.
- `requests` counts every request through the global dispatcher, including model API, `web_fetch`, and MCP.
- `tunnels.active` / `closedOnProxyLoss` — currently open tunnels, and how many were closed because the upstream vanished.

There is also an action endpoint for the settings panel, `POST /proxy-failover/api` with `{"action":"status"|"redetect"|"configure"}`. It accepts only requests whose Host is loopback or a configured trusted host, rejects cross-site requests, and requires any `Origin` to match that host; writes may change only `proxy` and `noProxy`.

State transitions in the log:

```text
[proxy-failover] upstream proxy enabled: http://127.0.0.1:7890 (source: port-probe:7890)
[proxy-failover] upstream proxy http://127.0.0.1:7890 unavailable; requests now go direct: ...
[proxy-failover] upstream proxy enabled: http://127.0.0.1:7890 (source: port-probe:7890)
```

## Security

- The relay **binds `127.0.0.1` only**, and refuses to `CONNECT` / forward to loopback, link-local (including `169.254.169.254` cloud metadata), multicast, 6to4, and NAT64 addresses.
- RFC1918 / CGNAT / ULA destinations are allowed: the global route also carries LAN model endpoints and MCP servers, matching a real proxy's direct behaviour. Tighten with `noProxy` or proxy rules if needed.
- `web_fetch`'s SSRF check is already skipped while "proxied"; this plugin keeps that semantic. With an upstream available the proxy decides the destination; without one, the relay applies the address filter above.
- **Fail-open:** module evaluation, `apply()`, probing, and the HTTP surfaces are all wrapped in `try/catch`; a failed install rolls the dispatcher and environment variables back, so a broken install never breaks working networking.
- The status surface is read-only (it returns a snapshot only) and applies the same trusted-host check; cross-site requests are rejected.

## Known limitations

- Only `http(s)://` proxies; no SOCKS or PAC (same as `@deepseek-ai/dsh-http-proxy`).
- Upstream auth supports only Basic credentials embedded in the URL.
- If the proxy is killed **mid-response**, an established tunnel still breaks — that is a transport fact. The plugin guarantees the *next* request needs no retry, not that a severed byte stream comes back.
- Port probing relies on a `CONNECT example.com:443` check; fully offline it may find no proxy and falls back to direct.
- The fake-ip fix depends on the instance identity of `@deepseek-ai/dsh-http-proxy`; the plugin resolves it through `DSH_HOME`, the install directory, `cwd`, and other anchors, then self-checks `routed` after installing.

## Links

- Repository: `https://github.com/PILIHU2022/dsh-proxy-failover`
- Sibling plugin (fake-ip fix only): `https://github.com/1499501762/dsh-web-fetch-proxy`
- English README: [README.en.md](../README.en.md)
- Chinese README: [README.md](../README.md)
- Issues: `https://github.com/PILIHU2022/dsh-proxy-failover/issues`
- License: [MIT](../LICENSE)
- Market entry (this directory): [market-entry.json](./market-entry.json) · [submission record](./market-submission.md)
- Market page: not generated yet (catalog PR pending, not listed)
