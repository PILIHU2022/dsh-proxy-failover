# dsh-proxy-failover

> A DeepSeek Harness plugin: route `web_fetch` through a local Mihomo/Clash proxy to
> bypass TUN fake-ip, and fall back to a direct connection when that proxy stops — so
> model requests never retry against a dead proxy.
>
> 中文: [README.md](./README.md)

## The failure

With Mihomo/Clash TUN + fake-ip, `web_fetch` fails with:

```
URL hostname "raw.githubusercontent.com" resolves to a non-public IP address
```

Installing a local proxy as the harness's process-wide proxy policy fixes the fetch
([dsh-web-fetch-proxy](https://github.com/1499501762/dsh-web-fetch-proxy) does exactly
that: `proxyRouteFor()` reports `proxied`, so the local DNS check is skipped). But that
policy is **process-wide and outlives the proxy**. Once the proxy is closed, every
outbound request — model calls included — still dials the dead port, fails, and is
retried until the turn breaks.

## Why another plugin

[dsh-web-fetch-proxy](https://github.com/1499501762/dsh-web-fetch-proxy) already solves
the fake-ip half: it installs the real local proxy (for example
`http://127.0.0.1:7897`) as the `@deepseek-ai/dsh-http-proxy` policy for the whole
process, so `web_fetch` sees a `proxied` route and skips its local DNS check. This plugin
keeps that approach.

The remaining problem is lifetime: the policy belongs to the DSH process, not to the proxy
process. After the proxy closes, the route still points at a port nobody listens on. Every
outbound request — model API calls included, and `dsh-llm-retry`'s retries — dials that
dead port, gets `ECONNREFUSED`, backs off, fails again, and the turn breaks; only a DSH
restart or a successful re-detect recovers it.

What this plugin adds:

- the process-wide route points at a **loopback relay** that starts with DSH and stays up,
  independent of the proxy process;
- each request decides for itself: tunnel to the upstream proxy when it is reachable,
  otherwise connect directly **inside the same request** and mark the upstream down;
- a health probe (1500 ms) switches back automatically when the proxy returns, including
  when the proxy starts after DSH;
- tunnels through a dead proxy are closed, so the client pool stops reusing them;
- direct DNS runs the OS resolver and c-ares in parallel, so a TUN-torn resolver cannot
  stall the first fallback for `resolveTimeoutMs`.

It is a functional superset: the fake-ip fix plus same-request fallback, automatic
switch-back, tunnel cleanup, and the c-ares rescue. Both plugins install a process-wide
route, so **do not enable both** (see the relationship section below).

## What this plugin does

It installs a **loopback relay** as the policy target instead of the real proxy.
The relay always accepts connections and decides the upstream per request:

- upstream reachable → tunnel to it (fake-ip stays a proxy-side concern);
- upstream dial fails → connect directly **inside the same request**, mark the
  upstream down, and stop dialling it;
- upstream comes back → the health loop (1.5 s) re-enables it automatically;
- the proxy dies → tunnels through it are closed immediately, so the client pool
  drops the dead connections instead of reusing them;
- direct DNS runs the OS resolver and c-ares in parallel, so a resolver still
  pointing at the torn-down TUN cannot stall the first fallback for 5 s.

New model calls therefore do not retry against a dead proxy when it disappears:
the route never goes stale, and the relay sends them direct. Only a reply that was
already streaming through the proxy at the moment it died fails once (see below).
An established stream is not cut by a plugin reload: the relay keeps existing
tunnels open when it stops accepting new ones.

## Install

The repository is public; npm is not published:

```bash
dsh plugin --profile web add github:PILIHU2022/dsh-proxy-failover
```

Or from a local checkout:

```bash
dsh plugin --profile web add link:/path/to/dsh-proxy-failover
```

Re-enable the inserted `proxy-failover` line (or restart DSH) after updating the code.

## Configuration

```yaml
- insert:
    - id: proxy-failover
      name: dsh-proxy-failover
      config:
        proxy: auto          # auto | off | http://127.0.0.1:7890
        noProxy: ""
        probeIntervalMs: 1500
        probeTimeoutMs: 400
        connectTimeoutMs: 10000
        handshakeTimeoutMs: 10000
        resolveTimeoutMs: 5000
        listenPort: 0        # 0 = random loopback port
```

`auto` discovers, in order: explicit config → `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`
→ Clash/Mihomo `mixed-port` from known config paths → well-known local ports.
Port-probed candidates must additionally answer a `CONNECT` handshake.

## Why one retry may still appear

- A reply that is **already streaming** through the proxy when it is killed must fail
  once; no process can migrate live TLS bytes. `dsh-llm-retry` re-runs that step.
- The re-run used to fail again because `dns.lookup()` was still stuck on the
  torn-down TUN DNS path for `resolveTimeoutMs` (5 s). With the parallel c-ares
  resolver the re-run normally succeeds on the first attempt
  (`relay.dns.lastSource = "cares"`).
- For **zero** retries, add the model host to `noProxy` (for example
  `api.deepseek.com`). Those requests then use the relay's direct branch and are
  unaffected by the proxy closing.

## Settings

`Failover Egress` appears under **Settings → General** with live status, the
auto/off/manual proxy modes, `noProxy`, and a re-detect action. Saves use the
`proxy-failover` settings namespace; both fields are `volatile`, so the Loader
applies them in place without remounting the plugin or changing the relay port.

The first version that ships `lib/client.js` needs one DSH restart for the Web
client bundle scanner to include it; the host status/action routes are live
without a restart.

## Status

Read-only, loopback only:

```bash
curl -s http://127.0.0.1:3080/proxy-failover/status | jq
```

`routed: true` means `proxyRouteFor()` points at the relay. `upstreamUp: false` with
`fallbacks > 0` means the proxy is gone and recent requests succeeded directly.
`relay.dns.lastSource = "cares"` proves the backup resolver answered while the OS
resolver was stalled; `relay.tunnels.closedOnProxyLoss` counts tunnels dropped when
the proxy disappeared.

## Do not run [dsh-web-fetch-proxy](https://github.com/1499501762/dsh-web-fetch-proxy) alongside

Both install a process-wide route. Disable `dsh-web-fetch-proxy` if it is
installed; this plugin is a superset: it fixes fake-ip and the
post-proxy-shutdown retry loop.

## Verification

```bash
node --test test/*.test.mjs   # 28 unit/integration tests
node scripts/verify.mjs       # live: proxied path + dead-proxy fallback + stalled-OS-DNS c-ares rescue
```

## Market listing

- Repository (public): [PILIHU2022/dsh-proxy-failover](https://github.com/PILIHU2022/dsh-proxy-failover)
- License: [MIT](./LICENSE)
- READMEs: [中文](./README.md) / [English](./README.en.md)
- Icon: [`assets/icon-180.png`](./assets/icon-180.png) — raster PNG, because the catalog
  rejects SVG icons
- Submission material: [`docs/market-listing.zh.md`](./docs/market-listing.zh.md),
  [`docs/market-listing.en.md`](./docs/market-listing.en.md),
  [`docs/market-entry.json`](./docs/market-entry.json), and
  [`docs/market-submission.md`](./docs/market-submission.md)

The catalog entry is `data/plugins/PILIHU2022__dsh-proxy-failover.yml` in
`awesome-dsh-plugin/awesome-dsh-plugin`; its PR is being submitted. That catalog requires
the repository to be at least 1 day old, so CI may stay pending for roughly 24 hours. It
is **not merged and not listed yet** — check the PR status.

## Limits

- HTTP(S) proxies only; no SOCKS or PAC.
- Basic proxy credentials from the URL only.
- A proxy killed mid-response drops that tunnel; the guarantee is that the **next**
  request succeeds without a retry (and the first retry after an in-flight failure
  normally succeeds once DNS is rescued by c-ares).
- `web_fetch`'s fake-ip fix relies on the same `@deepseek-ai/dsh-http-proxy` module
  instance; the plugin resolves it through harness-tree anchors and self-checks
  `routed` after installation.

## License

[MIT](./LICENSE)
