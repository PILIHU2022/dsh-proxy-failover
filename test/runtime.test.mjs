import assert from "node:assert/strict";
import test from "node:test";
import { startRuntime } from "../lib/runtime.js";
import { loadHarnessProxy, localAddress, startForwardProxy, startHttpOrigin } from "./helpers.mjs";

const host = localAddress();
const skip = host === undefined ? "no non-internal IPv4 address on this host" : false;

// The harness that runs the suite may already export its own live relay through
// these names; a fresh DSH process would not, so remove them before the install.
const savedProxyEnv = {};
for (const name of ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "NO_PROXY", "no_proxy"]) {
  savedProxyEnv[name] = process.env[name];
  delete process.env[name];
}
delete process.env.NODE_USE_ENV_PROXY;

test.after(() => {
  for (const [name, value] of Object.entries(savedProxyEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function harnessSeam() {
  const proxy = await loadHarnessProxy();
  if (proxy === undefined) return { ok: false, reason: "harness package not resolvable in this environment" };
  return { ok: true, proxy };
}

test("installs the relay, fails over to direct, and re-enables the proxy", { skip }, async (t) => {
  const harness = await harnessSeam();
  if (harness.ok !== true) {
    t.skip(harness.reason);
    return;
  }

  const previousHttpsProxy = process.env.HTTPS_PROXY;
  const previousLower = process.env.https_proxy;
  const origin = await startHttpOrigin({ body: "runtime-ok" });
  const upstream = await startForwardProxy();
  const logs = [];
  const runtime = await startRuntime({
    config: { proxy: upstream.url, probeIntervalMs: 60_000, probeTimeoutMs: 500 },
    log: (level, message) => logs.push(level + ": " + message),
    loadHarness: async () => harness,
  });

  assert.equal(runtime.ok, true, logs.join("\n"));
  try {
    assert.equal(process.env.HTTPS_PROXY, runtime.relay.url);
    assert.equal(process.env.https_proxy, runtime.relay.url);

    const route = harness.proxy.proxyRouteFor(new URL("https://raw.githubusercontent.com/1499501762/dsh-web-fetch-proxy/main/README.md"));
    assert.equal(route.proxied, true, "web_fetch must see a proxied route to skip the fake-ip DNS guard");
    assert.equal(route.proxy, runtime.relay.url);

    const first = await fetch(origin.url + "/one");
    assert.equal(await first.text(), "runtime-ok");
    assert.equal(upstream.stats.requests, 1);
    assert.equal(runtime.snapshot().relay.upstreamUp, true);

    // Closing the proxy is the failure the plugin exists for: the next request
    // must succeed on the same attempt through the direct fallback.
    await upstream.stop();
    const second = await fetch(origin.url + "/two");
    assert.equal(await second.text(), "runtime-ok");
    assert.equal(runtime.snapshot().relay.upstreamUp, false);
    assert.ok(runtime.snapshot().relay.fallbacks >= 1);

    // Turning the proxy back on is picked up by the health loop.
    const revived = await startForwardProxy({ port: upstream.port });
    try {
      await runtime.tick();
      assert.equal(runtime.snapshot().relay.upstreamUp, true);
      const third = await fetch(origin.url + "/three");
      assert.equal(await third.text(), "runtime-ok");
      assert.equal(revived.stats.requests, 1);
    } finally {
      await revived.close();
    }
  } finally {
    await runtime.dispose();
    await origin.close();
  }

  assert.equal(process.env.HTTPS_PROXY, previousHttpsProxy, "dispose must restore the launch environment");
  assert.equal(process.env.https_proxy, previousLower);
  const routeAfter = harness.proxy.proxyRouteFor(new URL("https://raw.githubusercontent.com/x"));
  assert.equal(routeAfter.proxied, false, "dispose must restore the previous dispatcher");
});

test("a dead pinned proxy still yields a working route", { skip }, async (t) => {
  const harness = await harnessSeam();
  if (harness.ok !== true) {
    t.skip(harness.reason);
    return;
  }
  const origin = await startHttpOrigin({ body: "dead-proxy-ok" });
  const runtime = await startRuntime({
    config: { proxy: "http://127.0.0.1:1", probeIntervalMs: 60_000, probeTimeoutMs: 300 },
    log: () => {},
    loadHarness: async () => harness,
  });
  assert.equal(runtime.ok, true);
  try {
    assert.equal(runtime.snapshot().relay.upstreamUp, false);
    assert.equal(runtime.snapshot().routed, true);
    const response = await fetch(origin.url + "/x");
    assert.equal(await response.text(), "dead-proxy-ok");
  } finally {
    await runtime.dispose();
    await origin.close();
  }
});

test("live reconfigure updates upstream and bypass in place", { skip }, async (t) => {
  const harness = await harnessSeam();
  if (harness.ok !== true) {
    t.skip(harness.reason);
    return;
  }
  const origin = await startHttpOrigin({ body: "reconfigure-ok" });
  const upstream = await startForwardProxy();
  const runtime = await startRuntime({
    config: { proxy: upstream.url, probeIntervalMs: 60_000 },
    log: () => {},
    loadHarness: async () => harness,
    env: process.env,
  });
  assert.equal(runtime.ok, true);
  try {
    const relayUrl = runtime.relay.url;
    assert.equal((await (await fetch(origin.url + "/via")).text()), "reconfigure-ok");
    assert.equal(upstream.stats.requests, 1);

    // Switch to a dead proxy: the same relay keeps serving, direct.
    await runtime.reconfigure({ proxy: "http://127.0.0.1:1" });
    assert.equal(runtime.relay.url, relayUrl, "the relay URL must not change");
    assert.equal(process.env.HTTPS_PROXY, relayUrl, "the policy must not be reinstalled");
    assert.equal((await (await fetch(origin.url + "/direct")).text()), "reconfigure-ok");

    // Switch back: new requests use the upstream again.
    await runtime.reconfigure({ proxy: upstream.url });
    assert.equal(runtime.relay.url, relayUrl);
    assert.equal((await (await fetch(origin.url + "/again")).text()), "reconfigure-ok");
    assert.equal(upstream.stats.requests, 2);

    // A bypass entry routes that host direct even while the proxy is up.
    await runtime.reconfigure({ noProxy: host });
    assert.equal((await (await fetch(origin.url + "/bypass")).text()), "reconfigure-ok");
    assert.equal(upstream.stats.requests, 2, "the bypassed request must not use the upstream");
  } finally {
    await runtime.dispose();
    await origin.close();
    await upstream.close();
  }
});
