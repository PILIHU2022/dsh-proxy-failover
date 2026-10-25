import assert from "node:assert/strict";
import test from "node:test";
import { createManager } from "../lib/manager.js";
import { normalizeConfig } from "../lib/runtime.js";
import { Config, validateSettings } from "../lib/index.js";

function fakeStart(recorder, behavior) {
  return async ({ config }) => {
    recorder.push({ kind: "start", proxy: config.proxy });
    const verdict = behavior?.(config) ?? "ok";
    if (verdict === "fail") return { ok: false, reason: "test failure" };
    let cfg = { ...config };
    return {
      ok: true,
      config: cfg,
      snapshot: () => ({ installed: true, proxy: { proxy: cfg.proxy, noProxy: cfg.noProxy } }),
      reconfigure: async (patch) => {
        recorder.push({ kind: "reconfigure", proxy: patch.proxy });
        if (behavior?.(patch) === "fail") return false;
        cfg = { ...cfg, ...patch };
        return true;
      },
      dispose: async () => {
        recorder.push({ kind: "dispose", proxy: config.proxy });
      },
      tick: async () => {
        recorder.push({ kind: "tick" });
      },
    };
  };
}

test("starts once and applies a live configuration change in place", async () => {
  const recorder = [];
  const manager = createManager({
    config: { proxy: "auto" },
    log: () => {},
    startRuntime: fakeStart(recorder),
  });
  try {
    assert.equal(await manager.start(), true);
    assert.equal(manager.snapshot().proxy.proxy, "auto");

    assert.equal(await manager.configure({ proxy: "http://127.0.0.1:7890" }), true);
    assert.deepEqual(recorder, [
      { kind: "start", proxy: "auto" },
      { kind: "reconfigure", proxy: "http://127.0.0.1:7890" },
    ]);
    assert.equal(manager.snapshot().proxy.proxy, "http://127.0.0.1:7890");

    const before = recorder.length;
    assert.equal(await manager.configure({ proxy: "http://127.0.0.1:7890" }), true);
    assert.equal(recorder.length, before, "an unchanged configuration must not reconfigure");

    assert.equal(await manager.redetect(), true);
    assert.equal(recorder[recorder.length - 1].kind, "tick");
  } finally {
    await manager.dispose();
  }
});

test("a failed live reconfigure keeps the previous configuration", async () => {
  const recorder = [];
  let failNext = false;
  const manager = createManager({
    config: { proxy: "auto" },
    log: () => {},
    startRuntime: fakeStart(recorder, () => (failNext ? "fail" : "ok")),
  });
  try {
    await manager.start();
    failNext = true;
    assert.equal(await manager.configure({ proxy: "http://127.0.0.1:9" }), false);
    assert.equal(manager.snapshot().proxy.proxy, "auto", "the previous config keeps serving");
  } finally {
    await manager.dispose();
  }
});

test("validateSettings accepts supported modes and rejects SOCKS", () => {
  assert.doesNotThrow(() => validateSettings({ proxy: "auto" }));
  assert.doesNotThrow(() => validateSettings({ proxy: "off" }));
  assert.doesNotThrow(() => validateSettings({ proxy: "127.0.0.1:7890" }));
  assert.doesNotThrow(() => validateSettings({ proxy: "http://127.0.0.1:7890" }));
  assert.throws(() => validateSettings({ proxy: "socks5://127.0.0.1:1080" }), /代理地址/);
  assert.throws(() => validateSettings({ proxy: "not a url" }), /代理地址/);
});

test("normalizeConfig unwraps schemastery volatile refs", () => {
  const ref = (value) => ({ get: () => value });
  const config = normalizeConfig({
    proxy: ref("off"),
    noProxy: ref("api.example.com"),
    probeIntervalMs: ref(2_000),
  });
  assert.equal(config.proxy, "off");
  assert.equal(config.noProxy, "api.example.com");
  assert.equal(config.probeIntervalMs, 2_000);
});

test("the exported Config projects two volatile settings fields", () => {
  assert.equal(typeof Config?.toJSON, "function");
  const json = Config.toJSON();
  const volatile = Object.values(json.refs).filter((entry) => entry?.meta?.volatile === true);
  assert.equal(volatile.length, 2);
  const resolved = Config({ proxy: "off", noProxy: "api.example.com" });
  const config = normalizeConfig(resolved);
  assert.equal(config.proxy, "off");
  assert.equal(config.noProxy, "api.example.com");
});
