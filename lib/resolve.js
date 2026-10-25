/**
 * Direct-connection DNS with a c-ares second opinion.
 *
 * When a TUN proxy is being torn down, the operating system's resolver can
 * stall for several seconds before it stops using the proxy's DNS path. A model
 * request that falls back to a direct connection during that window would sit
 * on `dns.lookup()` until the relay's timeout expires and then fail — which is
 * exactly the retry the user sees after closing the proxy.
 *
 * Two resolvers run in parallel and the first non-empty answer wins:
 *
 *   - `dns.lookup()` — the OS resolver, kept for search domains and hosts files;
 *   - a c-ares `Resolver` pointed at the system's own DNS servers, which sends
 *     fresh UDP queries immediately instead of waiting behind the OS state.
 *
 * Whichever answers first is used. If both are empty, the caller treats the
 * name as unresolvable.
 *
 * @module dsh-proxy-failover/resolve
 */
import dns from "node:dns";
import { isIP } from "node:net";

/** Public resolvers used only when the system reports no DNS servers at all. */
const FALLBACK_SERVERS = ["223.5.5.5", "1.1.1.1"];

function normalizeServers(servers) {
  const list = Array.isArray(servers) ? servers : [];
  const usable = [];
  for (const entry of list) {
    const value = typeof entry === "string" ? entry.trim() : "";
    if (value !== "") usable.push(value);
  }
  return usable.length > 0 ? usable : FALLBACK_SERVERS;
}

function osLookup(hostname, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish([]), timeoutMs);
    dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        finish([]);
        return;
      }
      finish(Array.isArray(addresses) ? addresses : []);
    });
  });
}

/**
 * Query the system's DNS servers through c-ares.
 *
 * Both A and AAAA are requested; a family with no records resolves empty and
 * does not disqualify the other. The resolver is cancelled when the overall
 * timeout wins, so a black-holed server cannot outlive the request.
 *
 * @param hostname - the name to resolve.
 * @param servers - DNS servers to ask.
 * @param timeoutMs - overall timeout.
 * @returns address records, or an empty array.
 */
function caresLookup(hostname, servers, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let pending = 2;
    let resolver;
    const finish = (addresses) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolver?.cancel();
      } catch {
        /* cancellation is best effort */
      }
      resolve(addresses);
    };
    const one = (addresses) => {
      if (settled) return;
      if (addresses.length > 0) {
        finish(addresses);
        return;
      }
      pending -= 1;
      if (pending === 0) finish([]);
    };
    const timer = setTimeout(() => finish([]), timeoutMs);

    try {
      resolver = new dns.Resolver();
      resolver.setServers(normalizeServers(servers));
    } catch {
      finish([]);
      return;
    }

    try {
      resolver.resolve4(hostname, (error, addresses) => {
        one(error ? [] : addresses.map((address) => ({ address, family: 4 })));
      });
      resolver.resolve6(hostname, (error, addresses) => {
        one(error ? [] : addresses.map((address) => ({ address, family: 6 })));
      });
    } catch {
      finish([]);
    }
  });
}

/** Resolve with the first non-empty answer; empty only when every source is empty. */
function firstNonEmpty(promises) {
  return new Promise((resolve) => {
    let pending = promises.length;
    let settled = false;
    for (const promise of promises) {
      Promise.resolve(promise).then(
        (result) => {
          if (settled) return;
          if (result.addresses.length > 0) {
            settled = true;
            resolve(result);
            return;
          }
          pending -= 1;
          if (pending === 0) {
            settled = true;
            resolve({ addresses: [], source: "none" });
          }
        },
        () => {
          if (settled) return;
          pending -= 1;
          if (pending === 0) {
            settled = true;
            resolve({ addresses: [], source: "none" });
          }
        },
      );
    }
  });
}

/**
 * Build a resolver.
 *
 * @param options - timeout, DNS servers, and test seams for both lookups.
 * @returns `async (hostname) => { addresses, source, ms }`.
 */
export function createAddressResolver(options) {
  const opts = options !== null && typeof options === "object" ? options : {};
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 5_000;
  const caresTimeoutMs = Math.max(300, Math.min(Number.isFinite(opts.caresTimeoutMs) ? opts.caresTimeoutMs : 1_500, timeoutMs));
  const lookupOs = typeof opts.osLookup === "function" ? opts.osLookup : (hostname) => osLookup(hostname, timeoutMs);
  const lookupCares = typeof opts.caresLookup === "function"
    ? opts.caresLookup
    : (hostname) => caresLookup(hostname, typeof opts.servers === "function" ? opts.servers() : opts.servers ?? dns.getServers(), caresTimeoutMs);

  return async function resolveAddresses(hostname) {
    const literal = isIP(hostname);
    if (literal !== 0) {
      return { addresses: [{ address: hostname, family: literal }], source: "literal", ms: 0 };
    }
    const started = Date.now();
    const result = await firstNonEmpty([
      Promise.resolve()
        .then(() => lookupOs(hostname))
        .then((addresses) => ({ addresses: Array.isArray(addresses) ? addresses : [], source: "os" })),
      Promise.resolve()
        .then(() => lookupCares(hostname))
        .then((addresses) => ({ addresses: Array.isArray(addresses) ? addresses : [], source: "cares" })),
    ]);
    return { addresses: result.addresses, source: result.source, ms: Date.now() - started };
  };
}

export { osLookup as defaultOsLookup, caresLookup as defaultCaresLookup };
