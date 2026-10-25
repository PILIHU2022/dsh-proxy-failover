/**
 * Live verification against the machine's real network.
 *
 * 1. Install the relay with auto discovery and confirm it found the local proxy.
 * 2. Fetch a real URL through the installed dispatcher (the same path `web_fetch`
 *    and the model adapters use).
 * 3. Install the relay pinned to a dead port and fetch again: the request must
 *    succeed through the direct fallback, exactly as it must when Mihomo closes.
 *
 * Run with: node scripts/verify.mjs
 */
import { createAddressResolver } from "../lib/resolve.js";
import { startRuntime } from "../lib/runtime.js";
import { loadHarnessProxy } from "../test/helpers.mjs";

const RAW = "https://raw.githubusercontent.com/1499501762/dsh-web-fetch-proxy/main/README.md";

function line(label, value) {
  console.log(label.padEnd(34, ".") + " " + value);
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  return { status: response.status, length: text.length };
}

const harness = await loadHarnessProxy();
if (harness === undefined) {
  console.error("cannot resolve @deepseek-ai/dsh-http-proxy; run this from a dsh installation");
  process.exit(1);
}
const seam = async () => ({ ok: true, proxy: harness });

// This script may run from a shell that inherited the live relay as HTTPS_PROXY.
// Discovery must start from the launch environment the way a fresh DSH process would.
const cleanEnv = { ...process.env };
for (const name of [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "all_proxy",
  "ALL_PROXY",
  "NO_PROXY",
  "no_proxy",
  "DSH_PROXY_FAILOVER_RELAY",
]) {
  delete cleanEnv[name];
  delete process.env[name];
}
delete process.env.NODE_USE_ENV_PROXY;

const logs = [];
let runtime;

console.log("\n[1] auto discovery + proxied route");
runtime = await startRuntime({
  config: { proxy: "auto", probeIntervalMs: 60_000 },
  log: (level, message) => logs.push(level + ": " + message),
  loadHarness: seam,
  env: cleanEnv,
});
if (runtime.ok !== true) {
  console.error("start failed:", runtime.reason);
  process.exit(1);
}
try {
  const snapshot = runtime.snapshot();
  line("relay", snapshot.relay.listen);
  line("upstream", snapshot.relay.upstream?.url ?? "(none)");
  line("upstream source", snapshot.relay.upstream?.source ?? "-");
  line("upstream up", String(snapshot.relay.upstreamUp));
  const route = harness.proxyRouteFor(new URL(RAW));
  line("proxyRouteFor(raw...)", route.proxied ? "proxied -> " + route.proxy : "direct");
  const proxied = await fetchText(RAW);
  line("fetch raw.githubusercontent", proxied.status + " (" + proxied.length + " bytes)");
  const example = await fetchText("https://example.com/");
  line("fetch example.com", example.status + " (" + example.length + " bytes)");
} finally {
  await runtime.dispose();
}

console.log("\n[2] pinned dead proxy (simulates Mihomo closed)");
runtime = await startRuntime({
  config: { proxy: "http://127.0.0.1:1", probeIntervalMs: 60_000, probeTimeoutMs: 300 },
  log: (level, message) => logs.push(level + ": " + message),
  loadHarness: seam,
  env: cleanEnv,
});
if (runtime.ok !== true) {
  console.error("start failed:", runtime.reason);
  process.exit(1);
}
try {
  line("upstream up", String(runtime.snapshot().relay.upstreamUp));
  const direct = await fetchText(RAW);
  line("fetch raw.githubusercontent", direct.status + " (" + direct.length + " bytes)");
  line("fallback count", String(runtime.snapshot().relay.fallbacks));
} finally {
  await runtime.dispose();
}

console.log("\n[3] stalled OS resolver (simulates the post-TUN DNS gap)");
const stalledOsResolver = createAddressResolver({
  timeoutMs: 5_000,
  osLookup: () => new Promise(() => {}),
});
runtime = await startRuntime({
  config: { proxy: "http://127.0.0.1:1", probeIntervalMs: 60_000, probeTimeoutMs: 300 },
  log: (level, message) => logs.push(level + ": " + message),
  loadHarness: seam,
  env: cleanEnv,
  resolver: stalledOsResolver,
});
if (runtime.ok !== true) {
  console.error("start failed:", runtime.reason);
  process.exit(1);
}
try {
  const rescued = await fetchText("https://example.com/");
  line("fetch example.com", rescued.status + " (" + rescued.length + " bytes)");
  line("dns source", runtime.snapshot().relay.dns.lastSource ?? "-");
  line("dns fallbacks", String(runtime.snapshot().relay.dns.fallbacks));
  line("dns last ms", String(runtime.snapshot().relay.dns.lastMs));
} finally {
  await runtime.dispose();
}

console.log("\nlogs:");
for (const entry of logs) console.log("  " + entry);
console.log("\nOK");
