import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectCandidates,
  normalizeProxyUrl,
  parseMixedPort,
  scanCandidates,
  verifyHttpProxy,
} from "../lib/discover.js";
import { localAddress, startEchoServer, startForwardProxy } from "./helpers.mjs";

const host = localAddress();
const skip = host === undefined ? "no non-internal IPv4 address on this host" : false;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-proxy-failover-"));
}

test("normalizes supported proxy URLs and rejects SOCKS/PAC", () => {
  assert.equal(normalizeProxyUrl("http://127.0.0.1:7890").url, "http://127.0.0.1:7890");
  assert.equal(normalizeProxyUrl("127.0.0.1:7890").url, "http://127.0.0.1:7890");
  assert.equal(normalizeProxyUrl("https://proxy.example:8443").port, 8443);
  assert.equal(normalizeProxyUrl("socks5://127.0.0.1:1080"), undefined);
  assert.equal(normalizeProxyUrl("pac+http://127.0.0.1:7890"), undefined);
  assert.equal(normalizeProxyUrl("   "), undefined);
  const authenticated = normalizeProxyUrl("http://user:pa%20ss@127.0.0.1:7890");
  assert.equal(authenticated.auth, "Basic " + Buffer.from("user:pa ss").toString("base64"));
});

test("reads mixed-port out of Clash-family YAML", () => {
  assert.equal(parseMixedPort("mixed-port: 7890\n"), 7890);
  assert.equal(parseMixedPort("verge_mixed_port: 7897\n"), 7897);
  assert.equal(parseMixedPort("# mixed-port: 1\nport: 7890\n"), undefined);
  assert.equal(parseMixedPort("mixed-port: not-a-number\n"), undefined);
});

test("collects ranked, deduplicated candidates and skips its own relay", () => {
  const dir = tempDir();
  const clashFile = path.join(dir, "config.yaml");
  fs.writeFileSync(clashFile, "mixed-port: 7897\n");

  const candidates = collectCandidates({
    proxy: "auto",
    env: { HTTPS_PROXY: "http://127.0.0.1:7890" },
    ports: [7890, 7898],
    clashFiles: [clashFile],
  });
  assert.deepEqual(
    candidates.map((candidate) => [candidate.url, candidate.source, candidate.trusted]),
    [
      ["http://127.0.0.1:7890", "env:HTTPS_PROXY", true],
      ["http://127.0.0.1:7897", "clash-config:" + clashFile, true],
      ["http://127.0.0.1:7898", "port-probe:7898", false],
    ],
  );

  const pinned = collectCandidates({ proxy: "http://127.0.0.1:7777", env: {}, ports: [7890] });
  assert.deepEqual(pinned.map((candidate) => candidate.url), ["http://127.0.0.1:7777"]);

  const selfSkipped = collectCandidates({
    proxy: "auto",
    env: { DSH_PROXY_FAILOVER_RELAY: "http://127.0.0.1:7890", HTTPS_PROXY: "http://127.0.0.1:7890" },
    ports: [],
    clashFiles: [path.join(dir, "absent.yaml")],
  });
  assert.deepEqual(selfSkipped, []);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("trusted candidates skip CONNECT verification, untrusted ones must pass it", { skip }, async () => {
  const proxy = await startForwardProxy();
  const echo = await startEchoServer();
  const cache = new Map();
  try {
    const trusted = await scanCandidates(
      [{ ...normalizeProxyUrl(proxy.url), source: "env:HTTPS_PROXY", trusted: true }],
      { probeTimeoutMs: 500, verifyTimeoutMs: 2_000, cache },
    );
    assert.equal(trusted?.url, proxy.url);
    assert.equal(proxy.stats.connects, 0);

    const untrusted = await scanCandidates(
      [{ ...normalizeProxyUrl(proxy.url), source: "port-probe:" + proxy.port, trusted: false }],
      {
        probeTimeoutMs: 500,
        verifyTimeoutMs: 2_000,
        verifyTarget: { host, port: echo.port },
        cache,
      },
    );
    assert.equal(untrusted?.url, proxy.url);
    assert.equal(proxy.stats.connects, 1);

    const notAProxy = await scanCandidates(
      [{ ...normalizeProxyUrl("http://127.0.0.1:" + echo.port), source: "port-probe:" + echo.port, trusted: false }],
      {
        probeTimeoutMs: 500,
        verifyTimeoutMs: 1_000,
        verifyTarget: { host, port: echo.port },
        cache: new Map(),
      },
    );
    assert.equal(notAProxy, undefined);
  } finally {
    await proxy.close();
    await echo.close();
  }
});

test("verifyHttpProxy reports a 2xx CONNECT", { skip }, async () => {
  const proxy = await startForwardProxy();
  const echo = await startEchoServer();
  try {
    const parsed = normalizeProxyUrl(proxy.url);
    assert.equal(await verifyHttpProxy(parsed, { host, port: echo.port }, 2_000), true);
    assert.equal(await verifyHttpProxy(parsed, { host: "127.0.0.1", port: 1 }, 800), false);
  } finally {
    await proxy.close();
    await echo.close();
  }
});
