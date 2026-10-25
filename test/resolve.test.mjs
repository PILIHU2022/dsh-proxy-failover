import assert from "node:assert/strict";
import test from "node:test";
import { createAddressResolver } from "../lib/resolve.js";

test("resolves IP literals without a lookup", async () => {
  const resolver = createAddressResolver({
    osLookup: () => {
      throw new Error("must not be called");
    },
    caresLookup: () => {
      throw new Error("must not be called");
    },
  });
  assert.deepEqual(await resolver("192.168.1.10"), {
    addresses: [{ address: "192.168.1.10", family: 4 }],
    source: "literal",
    ms: 0,
  });
  assert.equal((await resolver("::1")).addresses[0].family, 6);
});

test("returns the OS answer when it arrives first", async () => {
  const resolver = createAddressResolver({
    timeoutMs: 1_000,
    osLookup: async () => [{ address: "203.0.113.10", family: 4 }],
    caresLookup: () => new Promise(() => {}),
  });
  const result = await resolver("example.test");
  assert.deepEqual(result.addresses, [{ address: "203.0.113.10", family: 4 }]);
  assert.equal(result.source, "os");
});

test("a stalled OS resolver does not delay a working c-ares answer", async () => {
  const resolver = createAddressResolver({
    timeoutMs: 1_000,
    osLookup: () => new Promise(() => {}),
    caresLookup: async () => [{ address: "203.0.113.20", family: 4 }],
  });
  const started = Date.now();
  const result = await resolver("example.test");
  assert.deepEqual(result.addresses, [{ address: "203.0.113.20", family: 4 }]);
  assert.equal(result.source, "cares");
  assert.ok(Date.now() - started < 500, "must not wait for the OS timeout");
});

test("both resolvers empty yields an empty result", async () => {
  const resolver = createAddressResolver({
    timeoutMs: 500,
    osLookup: async () => [],
    caresLookup: async () => [],
  });
  const result = await resolver("does-not-exist.test");
  assert.deepEqual(result.addresses, []);
  assert.equal(result.source, "none");
});
