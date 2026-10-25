/**
 * Upstream proxy discovery for dsh-proxy-failover.
 *
 * Everything here is node: builtins only, so discovery can never make the
 * plugin unloadable. Candidates are ranked by confidence:
 *
 *   1. an explicit `proxy` config value      (trusted)
 *   2. HTTP(S)_PROXY / ALL_PROXY              (trusted)
 *   3. the mixed-port of a local Clash config (trusted)
 *   4. well-known local proxy ports           (verified with a CONNECT probe)
 *
 * Every candidate must accept a TCP connection before it is returned, so a
 * stale config entry never becomes the active route.
 *
 * @module dsh-proxy-failover/discover
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

/** Local ports commonly used by Clash, Mihomo, Clash Verge, v2rayN and Surge. */
export const DEFAULT_PORTS = [7890, 7897, 7891, 7899, 10809, 10808, 1080, 2080, 20171, 8889];

/** Proxy environment variables consulted in order. */
export const ENV_NAMES = [
  "https_proxy",
  "HTTPS_PROXY",
  "http_proxy",
  "HTTP_PROXY",
  "all_proxy",
  "ALL_PROXY",
];

/** Keys Clash-family configs use for the mixed HTTP(S) listener. */
const MIXED_PORT_KEYS = ["mixed-port", "mixed_port", "verge_mixed_port", "verge-mixed-port"];

/** Default CONNECT target used to prove that an untrusted port really is an HTTP proxy. */
export const DEFAULT_VERIFY_TARGET = { host: "example.com", port: 443 };

/** How long an unverified candidate stays disqualified after a failed probe. */
const REJECT_TTL_MS = 60_000;

function stripQuotes(value) {
  let out = String(value).trim();
  if (out.length >= 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) out = out.slice(1, -1);
  }
  return out;
}

function stripBrackets(hostname) {
  const text = String(hostname);
  return text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
}

function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Normalize one proxy endpoint.
 *
 * Accepts `http://host:port`, `https://host:port`, and the bare `host:port`
 * shorthand. SOCKS, PAC and every other scheme is rejected: this relay speaks
 * HTTP CONNECT only.
 *
 * @param value - the candidate value.
 * @returns a parsed endpoint or undefined.
 */
export function normalizeProxyUrl(value) {
  if (typeof value !== "string") return undefined;
  const raw = stripQuotes(value);
  if (raw === "") return undefined;
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : "http://" + raw;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  const hostname = stripBrackets(parsed.hostname);
  if (hostname === "") return undefined;
  const port = parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;

  const username = parsed.username === "" ? "" : decodeURIComponent(parsed.username);
  const password = parsed.password === "" ? "" : decodeURIComponent(parsed.password);
  const auth = username !== "" || password !== "" ? "Basic " + Buffer.from(username + ":" + password).toString("base64") : undefined;
  return {
    url: parsed.origin,
    protocol: parsed.protocol,
    hostname,
    port,
    auth,
  };
}

/**
 * Read the mixed-port out of a Clash-family YAML document without a YAML
 * parser. The key is always a top-level scalar in every config family this
 * plugin knows about.
 *
 * @param text - YAML text.
 * @returns the port, or undefined.
 */
export function parseMixedPort(text) {
  if (typeof text !== "string") return undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const key = stripQuotes(trimmed.slice(0, colon));
    if (MIXED_PORT_KEYS.indexOf(key) < 0) continue;
    const rest = trimmed.slice(colon + 1).split("#")[0].trim();
    const port = Number(stripQuotes(rest));
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  }
  return undefined;
}

/**
 * The Clash-family config files worth reading on this platform.
 *
 * @param options - home/AppData/LocalAppData overrides.
 * @returns absolute candidate paths.
 */
export function clashConfigFiles(options) {
  const opts = options !== null && typeof options === "object" ? options : {};
  const home = opts.home || os.homedir();
  const appData = opts.appData || process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const localAppData = opts.localAppData || process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  return [
    path.join(appData, "io.github.clash-verge-rev.clash-verge-rev", "config.yaml"),
    path.join(appData, "io.github.clash-verge-rev.clash-verge-rev", "clash-verge.yaml"),
    path.join(localAppData, "io.github.clash-verge-rev.clash-verge-rev", "config.yaml"),
    path.join(appData, "clash-verge", "config.yaml"),
    path.join(appData, "clash-verge-rev", "config.yaml"),
    path.join(appData, "clash", "config.yaml"),
    path.join(home, ".config", "clash", "config.yaml"),
    path.join(home, ".config", "mihomo", "config.yaml"),
    path.join(home, ".config", "clash-verge", "config.yaml"),
    path.join(home, ".local", "share", "mihomo", "config.yaml"),
  ];
}

/**
 * Find the mixed-port of a Clash-family config on disk.
 *
 * @param options - overrides for tests.
 * @returns `{ port, file }` or undefined.
 */
export function readClashMixedPort(options) {
  const opts = options !== null && typeof options === "object" ? options : {};
  const files = Array.isArray(opts.files) && opts.files.length > 0 ? opts.files : clashConfigFiles(opts);
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const port = parseMixedPort(text);
    if (port !== undefined) return { port, file };
  }
  return undefined;
}

/** Resolve when a TCP connection to host:port is established, false otherwise. */
export function probeTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let socket;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {
        /* best effort */
      }
      resolve(value);
    };
    try {
      socket = net.connect({ host, port });
    } catch {
      finish(false);
      return;
    }
    socket.setTimeout(typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 400);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/**
 * Prove that a listening port is an HTTP proxy by issuing a CONNECT request.
 *
 * @param candidate - a parsed endpoint with hostname/port.
 * @param target - the CONNECT target.
 * @param timeoutMs - whole-probe timeout.
 * @returns true when a 2xx CONNECT response arrives.
 */
export function verifyHttpProxy(candidate, target, timeoutMs) {
  const opts = target !== null && typeof target === "object" ? target : DEFAULT_VERIFY_TARGET;
  const host = opts.host || DEFAULT_VERIFY_TARGET.host;
  const port = Number(opts.port) > 0 ? Number(opts.port) : DEFAULT_VERIFY_TARGET.port;
  return new Promise((resolve) => {
    let settled = false;
    let socket;
    let buffer = Buffer.alloc(0);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        /* best effort */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 1500);
    try {
      socket = candidate.protocol === "https:"
        ? tls.connect({ host: candidate.hostname, port: candidate.port, servername: candidate.hostname })
        : net.connect({ host: candidate.hostname, port: candidate.port });
    } catch {
      finish(false);
      return;
    }
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
    socket.setTimeout(typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 1500, () => finish(false));
    socket.once(candidate.protocol === "https:" ? "secureConnect" : "connect", () => {
      const authority = host.includes(":") && !host.startsWith("[") ? "[" + host + "]:" + port : host + ":" + port;
      const auth = candidate.auth !== undefined ? "Proxy-Authorization: " + candidate.auth + "\r\n" : "";
      try {
        socket.write("CONNECT " + authority + " HTTP/1.1\r\nHost: " + authority + "\r\n" + auth + "\r\n");
      } catch (error) {
        finish(false);
        void error;
      }
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 32768) {
        finish(false);
        return;
      }
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const line = buffer.subarray(0, end).toString("latin1").split("\r\n")[0] || "";
      const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(line);
      finish(match !== null && Number(match[1]) >= 200 && Number(match[1]) < 300);
    });
  }).catch(() => false);
}

/**
 * Build the ranked candidate list from configuration, the launch environment,
 * Clash configs and well-known ports.
 *
 * @param options - proxy/environment/port overrides.
 * @returns deduplicated candidates in priority order.
 */
export function collectCandidates(options) {
  const opts = options !== null && typeof options === "object" ? options : {};
  const env = opts.env !== null && typeof opts.env === "object" ? opts.env : process.env;
  const explicit = typeof opts.proxy === "string" ? opts.proxy.trim() : "auto";
  const selfMarkers = new Set();
  const marker = env.DSH_PROXY_FAILOVER_RELAY;
  if (typeof marker === "string" && marker.trim() !== "") selfMarkers.add(marker.trim());
  for (const entry of Array.isArray(opts.selfUrls) ? opts.selfUrls : []) {
    if (typeof entry === "string" && entry.trim() !== "") selfMarkers.add(entry.trim());
  }

  const candidates = [];
  const seen = new Set();
  const add = (candidate) => {
    if (candidate === undefined) return;
    const key = candidate.hostname + ":" + candidate.port;
    if (seen.has(key)) return;
    if (selfMarkers.has(candidate.url)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  if (explicit !== "" && explicit.toLowerCase() !== "auto") {
    const parsed = normalizeProxyUrl(explicit);
    if (parsed !== undefined) add({ ...parsed, source: "config", trusted: true });
    return candidates;
  }

  for (const envName of ENV_NAMES) {
    const raw = env[envName];
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const parsed = normalizeProxyUrl(raw);
    if (parsed === undefined) continue;
    add({ ...parsed, source: "env:" + envName, trusted: true });
  }

  const clash = readClashMixedPort({
    home: opts.home,
    appData: opts.appData,
    localAppData: opts.localAppData,
    files: opts.clashFiles,
  });
  if (clash !== undefined) {
    const parsed = normalizeProxyUrl("http://127.0.0.1:" + clash.port);
    if (parsed !== undefined) add({ ...parsed, source: "clash-config:" + clash.file, trusted: true });
  }

  const ports = Array.isArray(opts.ports) ? opts.ports : DEFAULT_PORTS;
  for (const port of ports) {
    const number = Number(port);
    if (!Number.isInteger(number) || number <= 0 || number > 65535) continue;
    const parsed = normalizeProxyUrl("http://127.0.0.1:" + number);
    if (parsed !== undefined) add({ ...parsed, source: "port-probe:" + number, trusted: false });
  }

  return candidates;
}

/**
 * Probe candidates in priority order and return the first usable one.
 *
 * Trusted candidates only need an open TCP port; port-probed candidates must
 * also answer a CONNECT request. Failed verification results are cached so a
 * non-proxy service on a well-known port is not re-probed on every tick.
 *
 * @param candidates - as returned by {@link collectCandidates}.
 * @param options - timeouts, verification target, logger and cache.
 * @returns the chosen candidate or undefined.
 */
export async function scanCandidates(candidates, options) {
  const opts = options !== null && typeof options === "object" ? options : {};
  const list = Array.isArray(candidates) ? candidates : [];
  const timeoutMs = Number.isFinite(opts.probeTimeoutMs) && opts.probeTimeoutMs > 0 ? opts.probeTimeoutMs : 400;
  const verifyTimeoutMs = Number.isFinite(opts.verifyTimeoutMs) && opts.verifyTimeoutMs > 0 ? opts.verifyTimeoutMs : 1500;
  const verifyTarget = opts.verifyTarget !== null && typeof opts.verifyTarget === "object" ? opts.verifyTarget : DEFAULT_VERIFY_TARGET;
  const cache = opts.cache instanceof Map ? opts.cache : new Map();

  const opened = await Promise.all(list.map((candidate) => probeTcp(candidate.hostname, candidate.port, timeoutMs)));
  for (let index = 0; index < list.length; index += 1) {
    if (!opened[index]) continue;
    const candidate = list[index];
    if (candidate.trusted === true) return candidate;
    const cached = cache.get(candidate.url);
    if (cached !== undefined) {
      if (cached.ok === true) return candidate;
      if (Date.now() - cached.at < REJECT_TTL_MS) continue;
    }
    const ok = await verifyHttpProxy(candidate, verifyTarget, verifyTimeoutMs);
    cache.set(candidate.url, { ok, at: Date.now() });
    if (ok) return candidate;
    if (typeof opts.log === "function") {
      opts.log("warn", "端口 " + candidate.port + " 可连接但不是可用的 HTTP 代理，已跳过。");
    }
  }
  return undefined;
}

export { describe as describeError };
