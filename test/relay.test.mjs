import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createRelay, isBlockedAddress } from "../lib/relay.js";
import { localAddress, openTunnel, proxiedGet, startEchoServer, startForwardProxy, startHttpOrigin } from "./helpers.mjs";

const host = localAddress();
const skip = host === undefined ? "no non-internal IPv4 address on this host" : false;

function readOnce(socket) {
  return new Promise((resolve) => {
    socket.once("data", (chunk) => resolve(chunk));
  });
}

function endpoint(url, source = "test") {
  const parsed = new URL(url);
  return {
    url: parsed.origin,
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: Number(parsed.port),
    source,
    trusted: true,
  };
}

test("blocks loopback, link-local and multicast, but allows fake-ip and private LAN", () => {
  assert.equal(isBlockedAddress("127.0.0.1"), true);
  assert.equal(isBlockedAddress("127.8.8.8"), true);
  assert.equal(isBlockedAddress("0.0.0.0"), true);
  assert.equal(isBlockedAddress("169.254.169.254"), true);
  assert.equal(isBlockedAddress("224.0.0.1"), true);
  assert.equal(isBlockedAddress("::1"), true);
  assert.equal(isBlockedAddress("fe80::1"), true);
  assert.equal(isBlockedAddress("::ffff:127.0.0.1"), true);
  assert.equal(isBlockedAddress("64:ff9b::7f00:1"), true, "NAT64-mapped loopback");
  assert.equal(isBlockedAddress("2002:7f00:1::"), true, "6to4-mapped loopback");
  assert.equal(isBlockedAddress("2001:db8::1"), true, "documentation range");
  assert.equal(isBlockedAddress("198.18.0.22"), false, "Mihomo fake-ip must stay usable");
  assert.equal(isBlockedAddress("192.168.1.20"), false, "LAN services must keep working");
  assert.equal(isBlockedAddress("10.0.0.5"), false);
  assert.equal(isBlockedAddress("fdfe:dcba:9876::ed"), false, "IPv6 fake-ip range");
  assert.equal(isBlockedAddress("2606:4700:4700::1111"), false);
});

test("CONNECT goes direct when no upstream is known", { skip }, async () => {
  const echo = await startEchoServer();
  const relay = createRelay({ log: () => {} });
  await relay.listen("127.0.0.1", 0);
  try {
    const tunnel = await openTunnel(relay.url, host + ":" + echo.port);
    assert.equal(tunnel.status, 200);
    tunnel.socket.write("ping");
    const reply = await readOnce(tunnel.socket);
    assert.equal(reply.toString("utf8"), "echo:ping");
    tunnel.socket.destroy();
  } finally {
    await relay.close();
    await echo.close();
  }
});

test("CONNECT tunnels through a live upstream", { skip }, async () => {
  const echo = await startEchoServer();
  const upstream = await startForwardProxy();
  const relay = createRelay({ log: () => {} });
  relay.setUpstream(endpoint(upstream.url));
  await relay.listen("127.0.0.1", 0);
  try {
    const tunnel = await openTunnel(relay.url, host + ":" + echo.port);
    assert.equal(tunnel.status, 200);
    tunnel.socket.write("via-proxy");
    assert.equal((await readOnce(tunnel.socket)).toString("utf8"), "echo:via-proxy");
    assert.equal(upstream.stats.connects, 1);
    tunnel.socket.destroy();
  } finally {
    await relay.close();
    await upstream.close();
    await echo.close();
  }
});

test("a dead upstream falls back to direct inside the same request", { skip }, async () => {
  const echo = await startEchoServer();
  const upstream = await startForwardProxy();
  const relay = createRelay({ log: () => {} });
  const upstreamEndpoint = endpoint(upstream.url);
  relay.setUpstream(upstreamEndpoint);
  await relay.listen("127.0.0.1", 0);
  try {
    const first = await openTunnel(relay.url, host + ":" + echo.port);
    assert.equal(first.status, 200);
    first.socket.destroy();
    assert.equal(upstream.stats.connects, 1);

    await upstream.stop();

    const second = await openTunnel(relay.url, host + ":" + echo.port);
    assert.equal(second.status, 200, "the fallback must answer the same request");
    second.socket.write("after-death");
    assert.equal((await readOnce(second.socket)).toString("utf8"), "echo:after-death");
    const snapshot = relay.snapshot();
    assert.equal(snapshot.upstreamUp, false);
    assert.ok(snapshot.fallbacks >= 1);
    second.socket.destroy();
  } finally {
    await relay.close();
    await echo.close();
  }
});

test("an upstream refusal is reported, never bypassed", { skip }, async () => {
  const echo = await startEchoServer();
  const upstream = await startForwardProxy({ refuseConnect: true });
  const relay = createRelay({ log: () => {} });
  relay.setUpstream(endpoint(upstream.url));
  await relay.listen("127.0.0.1", 0);
  try {
    const tunnel = await openTunnel(relay.url, host + ":" + echo.port);
    assert.equal(tunnel.status, 502);
    assert.equal(relay.snapshot().upstreamUp, true, "a refusal is not a dead proxy");
    assert.equal(echo.connections.count, 0, "no direct connection may follow a refusal");
  } finally {
    await relay.close();
    await upstream.close();
    await echo.close();
  }
});

test("plain HTTP requests are forwarded directly", { skip }, async () => {
  const origin = await startHttpOrigin({ body: "plain-direct" });
  const relay = createRelay({ log: () => {} });
  await relay.listen("127.0.0.1", 0);
  try {
    const response = await proxiedGet(relay.url, origin.url + "/hello");
    assert.equal(response.status, 200);
    assert.equal(response.body, "plain-direct");
    assert.equal(origin.requests.count, 1);
  } finally {
    await relay.close();
    await origin.close();
  }
});

test("plain HTTP requests use a live upstream", { skip }, async () => {
  const origin = await startHttpOrigin({ body: "plain-proxied" });
  const upstream = await startForwardProxy();
  const relay = createRelay({ log: () => {} });
  relay.setUpstream(endpoint(upstream.url));
  await relay.listen("127.0.0.1", 0);
  try {
    const response = await proxiedGet(relay.url, origin.url + "/hello");
    assert.equal(response.status, 200);
    assert.equal(response.body, "plain-proxied");
    assert.equal(upstream.stats.requests, 1);
  } finally {
    await relay.close();
    await upstream.close();
    await origin.close();
  }
});

test("loopback targets are refused even through the relay", { skip }, async () => {
  const origin = await startHttpOrigin();
  const relay = createRelay({ log: () => {} });
  await relay.listen("127.0.0.1", 0);
  try {
    const tunnel = await openTunnel(relay.url, "127.0.0.1:" + origin.port);
    assert.equal(tunnel.status, 403);
    assert.equal(origin.requests.count, 0);
  } finally {
    await relay.close();
    await origin.close();
  }
});

test("closing the relay keeps an established tunnel alive", { skip }, async () => {
  const echo = await startEchoServer();
  const relay = createRelay({ log: () => {} });
  await relay.listen("127.0.0.1", 0);
  const tunnel = await openTunnel(relay.url, host + ":" + echo.port);
  assert.equal(tunnel.status, 200);
  await relay.close();
  tunnel.socket.write("still-here");
  assert.equal((await readOnce(tunnel.socket)).toString("utf8"), "echo:still-here");
  tunnel.socket.destroy();
  await echo.close();
});

test("marking the upstream down closes only upstream tunnels", { skip }, async () => {
  const echo = await startEchoServer();
  const upstream = await startForwardProxy();
  const relay = createRelay({ log: () => {} });
  relay.setUpstream(endpoint(upstream.url));
  await relay.listen("127.0.0.1", 0);
  try {
    const via = await openTunnel(relay.url, host + ":" + echo.port);
    assert.equal(via.status, 200);
    assert.equal(relay.snapshot().tunnels.active, 1);

    const closed = once(via.socket, "close");
    relay.markUpstreamDown("test: proxy closed");
    await closed;

    const snapshot = relay.snapshot();
    assert.equal(snapshot.upstreamUp, false);
    assert.equal(snapshot.tunnels.active, 0);
    assert.ok(snapshot.tunnels.closedOnProxyLoss >= 1);

    const direct = await openTunnel(relay.url, host + ":" + echo.port);
    assert.equal(direct.status, 200, "the next request must use the direct path");
    direct.socket.write("after-loss");
    assert.equal((await readOnce(direct.socket)).toString("utf8"), "echo:after-loss");
    direct.socket.destroy();
  } finally {
    await relay.close();
    await upstream.close();
    await echo.close();
  }
});

test("records the c-ares fallback in the DNS metrics", { skip }, async () => {
  const echo = await startEchoServer();
  const relay = createRelay({
    log: () => {},
    resolver: async () => ({ addresses: [{ address: host, family: 4 }], source: "cares", ms: 2 }),
  });
  await relay.listen("127.0.0.1", 0);
  try {
    const tunnel = await openTunnel(relay.url, "fake-host.test:" + echo.port);
    assert.equal(tunnel.status, 200);
    const snapshot = relay.snapshot();
    assert.equal(snapshot.dns.fallbacks, 1);
    assert.equal(snapshot.dns.lastSource, "cares");
    assert.equal(snapshot.dns.failures, 0);
    tunnel.socket.destroy();
  } finally {
    await relay.close();
    await echo.close();
  }
});
