/**
 * A loopback HTTP proxy that keeps working when its upstream proxy disappears.
 *
 * WHY A RELAY
 * -----------
 * The harness installs one process-wide proxy policy. Installing the *real*
 * local proxy (Mihomo/Clash) there is what breaks a running session: when the
 * proxy is closed, every model request still dials the dead port, fails, and is
 * retried until the turn dies.
 *
 * This relay is always the policy target and always accepts connections. Each
 * tunnel or forwarded request picks an upstream at request time:
 *
 *   - the upstream is believed healthy  -> tunnel through it (TUN fake-ip stays
 *     a proxy concern, and `web_fetch` keeps its SSRF bypass through the proxy);
 *   - the upstream dial fails           -> mark it down and connect directly in
 *     the *same* request, so the model call never needs a retry;
 *   - the upstream is known to be down  -> connect directly without even trying.
 *
 * A dead proxy therefore costs one refused loopback connect, not a failed agent
 * step. A health loop re-enables the upstream when it comes back.
 *
 * @module dsh-proxy-failover/relay
 */
import http from "node:http";
import https from "node:https";
import net, { isIP } from "node:net";
import tls from "node:tls";

import { createAddressResolver } from "./resolve.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const MAX_HEAD_BYTES = 64 * 1024;

function noop() {}

function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function stripBrackets(hostname) {
  const text = String(hostname);
  return text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
}

/** Format `host:port` for a CONNECT authority, bracketing IPv6 literals. */
export function formatAuthority(hostname, port) {
  return isIP(hostname) === 6 ? "[" + hostname + "]:" + port : hostname + ":" + port;
}

function parseAuthority(value) {
  if (typeof value !== "string" || value === "") return undefined;
  let parsed;
  try {
    parsed = new URL("http://" + value);
  } catch {
    return undefined;
  }
  const hostname = stripBrackets(parsed.hostname);
  if (hostname === "") return undefined;
  const port = parsed.port === "" ? 443 : Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  return { hostname, port, authority: formatAuthority(hostname, port) };
}

function parseAbsolute(value) {
  if (typeof value !== "string" || value === "") return undefined;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  const hostname = stripBrackets(parsed.hostname);
  if (hostname === "") return undefined;
  const port = parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  return {
    protocol: parsed.protocol,
    hostname,
    port,
    host: parsed.host,
    path: parsed.pathname + parsed.search,
    href: parsed.href,
  };
}

/**
 * Whether an address must never be dialled directly by this relay.
 *
 * Loopback, link-local (including cloud metadata) and multicast are refused.
 * Private unicast (RFC1918, CGNAT, ULA) is allowed on purpose: the policy is
 * process-wide, so model endpoints and MCP servers on the LAN have to keep
 * working, exactly as they would through a real proxy. Loopback never arrives
 * here because the harness bypasses it in every proxy policy.
 *
 * @param address - textual IPv4 or IPv6 address.
 * @returns true when the relay must refuse the target.
 */
export function isBlockedAddress(address) {
  const family = isIP(address);
  if (family === 4) return isBlockedV4(address);
  if (family === 6) return isBlockedV6(address);
  return true;
}

function isBlockedV4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4) return true;
  const [a, b] = parts;
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  if (a === 0) return true; // 0.0.0.0/8, "this network"
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, cloud metadata
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function isBlockedV6(address) {
  const value = String(address).toLowerCase();
  if (value === "::" || value === "::1") return true;
  const mapped = mappedIpv4(value);
  if (mapped !== undefined) return isBlockedV4(mapped);
  if (/^fe[89ab]/.test(value)) return true; // fe80::/10 link-local
  if (/^fe[c-f]/.test(value)) return true; // fec0::/10 deprecated site-local
  if (value.startsWith("ff")) return true; // multicast
  if (value.startsWith("::")) return true; // IPv4-compatible and other reserved forms
  if (value.startsWith("2002:")) return true; // 6to4 embeds an IPv4 destination
  if (value.startsWith("64:ff9b:")) return true; // NAT64 embeds an IPv4 destination
  if (value.startsWith("2001:db8:")) return true; // documentation range
  return false;
}

function mappedIpv4(address) {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (dotted !== null) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex === null) return undefined;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

/** Prefer IPv4 for direct dials: a broken IPv6 route must not stall every request. */
function preferIpv4(addresses) {
  return [...addresses].sort((left, right) => (left.family === 4 ? 0 : 1) - (right.family === 4 ? 0 : 1));
}

function sanitizeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

class ProxyRefusal extends Error {
  constructor(status, line) {
    super("upstream proxy refused CONNECT: " + (line || status));
    this.name = "ProxyRefusal";
    this.status = status;
  }
}

/** Normalize a bypass list ("a.com, .b.com:8443, *") into matchable entries. */
function normalizeBypass(value) {
  const parts = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const entries = [];
  for (const part of parts) {
    const text = String(part).trim().toLowerCase();
    if (text !== "") entries.push(text);
  }
  return entries;
}

function splitBypassEntry(entry) {
  let host = entry;
  let port;
  if (!entry.startsWith("[")) {
    const index = entry.lastIndexOf(":");
    if (index > 0 && /^\d+$/.test(entry.slice(index + 1))) {
      host = entry.slice(0, index);
      port = Number(entry.slice(index + 1));
    }
  }
  host = host.replace(/^\*\./, "").replace(/^\./, "");
  return { host, port };
}

/**
 * Create the relay. Call {@link Relay.listen} before using {@link Relay.url}.
 *
 * @param options - logger and timeouts.
 * @returns the relay handle.
 */
export function createRelay(options) {
  const opts = options !== null && typeof options === "object" ? options : {};
  const log = typeof opts.log === "function" ? opts.log : noop;
  const connectTimeoutMs = clampInt(opts.connectTimeoutMs, 500, 60_000, 10_000);
  const handshakeTimeoutMs = clampInt(opts.handshakeTimeoutMs, 500, 60_000, 10_000);
  const resolveTimeoutMs = clampInt(opts.resolveTimeoutMs, 500, 60_000, 5_000);
  const resolveHost = typeof opts.resolver === "function"
    ? opts.resolver
    : createAddressResolver({ timeoutMs: resolveTimeoutMs, caresTimeoutMs: opts.caresTimeoutMs });

  const state = {
    upstream: undefined,
    up: false,
    lastError: undefined,
    checkedAt: 0,
    requests: 0,
    fallbacks: 0,
    lastFallbackAt: 0,
    tunnelsClosed: 0,
    bypass: [],
    dns: {
      fallbacks: 0,
      failures: 0,
      lastMs: 0,
      lastSource: undefined,
      lastError: undefined,
    },
  };

  const tunnels = new Set();

  let url;
  let closed = false;

  const server = http.createServer(
    {
      requestTimeout: 0,
      headersTimeout: 60_000,
      keepAliveTimeout: 5_000,
      maxHeaderSize: 64 * 1024,
    },
    handleHttpRequest,
  );

  server.on("error", (error) => {
    log("warn", "relay 监听错误：" + describe(error));
  });
  server.on("connect", handleConnect);
  server.on("upgrade", (req, socket) => {
    replySocket(socket, 501, "Not Implemented");
  });
  server.on("clientError", (error, socket) => {
    void error;
    replySocket(socket, 400, "Bad Request");
  });
  server.on("connection", (socket) => {
    socket.on("error", noop);
  });

  function setUpstream(candidate) {
    if (candidate === undefined || candidate === null) return;
    const previous = state.upstream;
    state.upstream = candidate;
    state.up = true;
    state.checkedAt = Date.now();
    state.lastError = undefined;
    if (previous === undefined || previous.url !== candidate.url) {
      log("info", "上游代理已启用：" + candidate.url + "（来源：" + candidate.source + "）");
    }
  }

  /** Replace the host bypass list used for direct-only destinations. */
  function setBypass(value) {
    state.bypass = normalizeBypass(value);
  }

  function matchesBypass(hostname, port) {
    const host = String(hostname).toLowerCase();
    for (const entry of state.bypass) {
      if (entry === "*") return true;
      const split = splitBypassEntry(entry);
      if (split.host === "") continue;
      if (split.port !== undefined && split.port !== port) continue;
      if (host === split.host || host.endsWith("." + split.host)) return true;
    }
    return false;
  }

  /** Stop using an upstream without pretending it died. */
  function clearUpstream(reason) {
    state.checkedAt = Date.now();
    state.lastError = reason;
    state.up = false;
    state.upstream = undefined;
    const closed = closeUpstreamTunnels();
    if (closed > 0) state.tunnelsClosed += closed;
  }

  function markUpstreamDown(reason) {
    state.checkedAt = Date.now();
    state.lastError = reason;
    if (state.up !== true) return;
    state.up = false;
    state.fallbacks += 1;
    state.lastFallbackAt = Date.now();
    log("warn", "上游代理 " + (state.upstream?.url ?? "?") + " 不可用，后续请求自动直连：" + reason);
    const closed = closeUpstreamTunnels();
    if (closed > 0) {
      state.tunnelsClosed += closed;
      log("info", "已关闭 " + closed + " 条经失效代理的隧道，客户端会立即改用新连接。");
    }
  }

  /** Drop every tunnel that went through the upstream; direct tunnels stay untouched. */
  function closeUpstreamTunnels() {
    let closed = 0;
    for (const entry of [...tunnels]) {
      if (entry.viaUpstream !== true) continue;
      tunnels.delete(entry);
      closed += 1;
      try {
        if (!entry.clientSocket.destroyed) entry.clientSocket.destroy();
      } catch {
        /* best effort */
      }
      try {
        if (!entry.upstreamSocket.destroyed) entry.upstreamSocket.destroy();
      } catch {
        /* best effort */
      }
    }
    return closed;
  }

  function snapshot() {
    return {
      listen: url,
      requests: state.requests,
      fallbacks: state.fallbacks,
      lastFallbackAt: state.lastFallbackAt,
      upstream: state.upstream === undefined
        ? undefined
        : { url: state.upstream.url, source: state.upstream.source, hostname: state.upstream.hostname, port: state.upstream.port },
      upstreamUp: state.up,
      lastError: state.lastError,
      checkedAt: state.checkedAt,
      tunnels: { active: tunnels.size, closedOnProxyLoss: state.tunnelsClosed },
      dns: {
        fallbacks: state.dns.fallbacks,
        failures: state.dns.failures,
        lastMs: state.dns.lastMs,
        lastSource: state.dns.lastSource,
        lastError: state.dns.lastError,
      },
    };
  }

  async function listen(host, port) {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      try {
        server.listen({ host, port });
      } catch (error) {
        server.off("error", onError);
        reject(error);
      }
    });
    const address = server.address();
    const boundPort = address !== null && typeof address === "object" ? address.port : port;
    const hostPart = host.includes(":") ? "[" + host + "]" : host;
    url = "http://" + hostPart + ":" + boundPort;
    server.unref();
    return url;
  }

  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      try {
        server.close(finish);
      } catch {
        finish();
      }
      try {
        server.closeIdleConnections?.();
      } catch {
        /* older runtimes have no closeIdleConnections */
      }
      // Active tunnels are deliberately left alone: a plugin reload must not cut
      // a streaming model reply. This timer only bounds the promise.
      const timer = setTimeout(finish, 1_000);
      timer.unref?.();
    });
  }

  // ------------------------------------------------------------------ CONNECT

  function handleConnect(req, clientSocket, head) {
    state.requests += 1;
    clientSocket.on("error", noop);
    clientSocket.pause();

    const target = parseAuthority(req.url);
    if (target === undefined) {
      replySocket(clientSocket, 400, "Bad Request");
      return;
    }
    if (isIP(target.hostname) !== 0 && isBlockedAddress(target.hostname)) {
      replySocket(clientSocket, 403, "Forbidden");
      return;
    }
    void routeConnect(target, clientSocket, head);
  }

  async function routeConnect(target, clientSocket, head) {
    try {
      const bypassed = matchesBypass(target.hostname, target.port);
      if (bypassed !== true && state.up === true && state.upstream !== undefined) {
        const via = await connectViaUpstream(target);
        if (via.kind === "ok") {
          establish(clientSocket, via.socket, head, via.tail, true);
          return;
        }
        if (via.kind === "refused") {
          replySocket(clientSocket, 502, "Bad Gateway");
          return;
        }
        markUpstreamDown(via.reason);
      }

      const direct = await connectDirect(target);
      if (direct.kind === "blocked") {
        replySocket(clientSocket, 403, "Forbidden");
        return;
      }
      if (direct.kind === "error") {
        replySocket(clientSocket, 502, "Bad Gateway");
        return;
      }
      establish(clientSocket, direct.socket, head, undefined, false);
    } catch (error) {
      log("warn", "建立隧道失败（" + target.authority + "）：" + describe(error));
      replySocket(clientSocket, 502, "Bad Gateway");
    }
  }

  async function connectViaUpstream(target) {
    const upstream = state.upstream;
    let socket;
    try {
      socket = await dialEndpoint(upstream);
    } catch (error) {
      return { kind: "down", reason: "连接上游失败: " + describe(error) };
    }
    try {
      const result = await proxyHandshake(socket, upstream, target);
      socket.setTimeout(0);
      return { kind: "ok", socket, tail: result.tail };
    } catch (error) {
      socket.destroy();
      if (error instanceof ProxyRefusal) return { kind: "refused", status: error.status };
      return { kind: "down", reason: "上游握手失败: " + describe(error) };
    }
  }

  function proxyHandshake(socket, upstream, target) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let buffer = Buffer.alloc(0);
      const cleanup = () => {
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("timeout", onTimeout);
        socket.setTimeout(0);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_HEAD_BYTES) {
          finish(reject, new Error("upstream CONNECT response head is too large"));
          return;
        }
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString("latin1");
        const tail = buffer.subarray(end + 4);
        const line = head.split("\r\n")[0] || "";
        const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(line);
        if (match === null) {
          finish(reject, new Error("invalid upstream CONNECT response: " + line));
          return;
        }
        const status = Number(match[1]);
        if (status >= 200 && status < 300) finish(resolve, { tail });
        else finish(reject, new ProxyRefusal(status, line));
      };
      const onError = (error) => finish(reject, error);
      const onTimeout = () => finish(reject, new Error("upstream CONNECT handshake timed out"));

      socket.setTimeout(handshakeTimeoutMs);
      socket.on("data", onData);
      socket.on("error", onError);
      socket.on("timeout", onTimeout);

      const auth = upstream.auth !== undefined ? "Proxy-Authorization: " + upstream.auth + "\r\n" : "";
      try {
        socket.write("CONNECT " + target.authority + " HTTP/1.1\r\nHost: " + target.authority + "\r\n" + auth + "\r\n");
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  async function connectDirect(target) {
    const addresses = await resolveAddresses(target.hostname);
    if (addresses.length === 0) return { kind: "error" };
    const allowed = preferIpv4(addresses.filter((entry) => !isBlockedAddress(entry.address)));
    if (allowed.length === 0) return { kind: "blocked" };
    for (const entry of allowed) {
      try {
        const socket = await dialAddress(entry.address, target.port);
        return { kind: "ok", socket };
      } catch {
        /* try the next address */
      }
    }
    return { kind: "error" };
  }

  function establish(clientSocket, upstreamSocket, head, tail, viaUpstream) {
    if (clientSocket.destroyed || clientSocket.writable !== true) {
      upstreamSocket.destroy();
      return;
    }
    try {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (tail !== undefined && tail.length > 0) clientSocket.write(tail);
      if (head !== undefined && head.length > 0) upstreamSocket.write(head);
    } catch (error) {
      void error;
      upstreamSocket.destroy();
      clientSocket.destroy();
      return;
    }
    tunnel(clientSocket, upstreamSocket, viaUpstream === true);
  }

  function tunnel(clientSocket, upstreamSocket, viaUpstream) {
    const entry = { clientSocket, upstreamSocket, viaUpstream };
    tunnels.add(entry);
    const forget = () => {
      tunnels.delete(entry);
    };
    clientSocket.once("close", forget);
    upstreamSocket.once("close", forget);
    const destroyBoth = () => {
      if (!clientSocket.destroyed) clientSocket.destroy();
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    };
    clientSocket.on("error", destroyBoth);
    upstreamSocket.on("error", destroyBoth);
    clientSocket.on("close", () => {
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    });
    upstreamSocket.on("close", () => {
      if (!clientSocket.destroyed) clientSocket.destroy();
    });
    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
    clientSocket.resume();
    upstreamSocket.resume();
  }

  function dialEndpoint(endpoint) {
    return new Promise((resolve, reject) => {
      const socket = endpoint.protocol === "https:"
        ? tls.connect({ host: endpoint.hostname, port: endpoint.port, servername: endpoint.hostname })
        : net.connect({ host: endpoint.hostname, port: endpoint.port });
      readySocket(socket, endpoint.protocol === "https:" ? "secureConnect" : "connect", resolve, reject);
    });
  }

  function dialAddress(address, port) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: address, port });
      readySocket(socket, "connect", resolve, reject);
    });
  }

  function readySocket(socket, readyEvent, resolve, reject) {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("connect timed out"));
    }, connectTimeoutMs);
    const onReady = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.setNoDelay(true);
      socket.off("error", onError);
      socket.on("error", noop);
      resolve(socket);
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.once(readyEvent, onReady);
    socket.once("error", onError);
  }

  async function resolveAddresses(hostname) {
    const result = await resolveHost(hostname);
    state.dns.lastMs = result.ms;
    state.dns.lastSource = result.source;
    if (result.source === "cares") state.dns.fallbacks += 1;
    if (result.addresses.length === 0) {
      state.dns.failures += 1;
      state.dns.lastError = "DNS 解析失败（" + result.ms + "ms，来源：" + result.source + "）";
    } else {
      state.dns.lastError = undefined;
    }
    return result.addresses;
  }

  // ------------------------------------------------------------- plain HTTP

  function handleHttpRequest(req, res) {
    state.requests += 1;
    const target = parseAbsolute(req.url);
    if (target === undefined || target.protocol !== "http:") {
      sendHttpError(res, 400, "Bad Request");
      return;
    }
    if (isIP(target.hostname) !== 0 && isBlockedAddress(target.hostname)) {
      sendHttpError(res, 403, "Forbidden");
      return;
    }
    void routeHttp(req, res, target).catch((error) => {
      log("warn", "转发 HTTP 请求失败（" + target.href + "）：" + describe(error));
      sendHttpError(res, 502, "Bad Gateway");
    });
  }

  async function routeHttp(req, res, target) {
    const bodyless = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
    const bypassed = matchesBypass(target.hostname, target.port);

    if (bypassed !== true && state.up === true && state.upstream !== undefined) {
      const outcome = await forwardOnce(req, res, target, true, undefined);
      if (outcome === "ok") return;
      markUpstreamDown("HTTP 请求连接上游失败");
      if (!bodyless) {
        sendHttpError(res, 502, "Bad Gateway");
        return;
      }
    }

    const addresses = await resolveAddresses(target.hostname);
    if (addresses.length === 0) {
      sendHttpError(res, 502, "Bad Gateway");
      return;
    }
    const allowed = preferIpv4(addresses.filter((entry) => !isBlockedAddress(entry.address)));
    if (allowed.length === 0) {
      sendHttpError(res, 403, "Forbidden");
      return;
    }
    for (const entry of allowed) {
      const outcome = await forwardOnce(req, res, target, false, entry.address);
      if (outcome === "ok") return;
      if (!bodyless) break;
    }
    sendHttpError(res, 502, "Bad Gateway");
  }

  function forwardOnce(req, res, target, viaUpstream, address) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const headers = sanitizeHeaders(req.headers);
      headers.host = target.host;

      let requester = http.request;
      let options;
      if (viaUpstream === true) {
        const upstream = state.upstream;
        options = {
          host: upstream.hostname,
          port: upstream.port,
          method: req.method,
          path: target.href,
          headers,
        };
        if (upstream.protocol === "https:") requester = https.request;
        if (upstream.auth !== undefined) headers["proxy-authorization"] = upstream.auth;
      } else {
        options = {
          host: address,
          port: target.port,
          method: req.method,
          path: target.path,
          headers,
        };
      }

      let out;
      try {
        out = requester(options);
      } catch (error) {
        void error;
        finish("error");
        return;
      }

      out.on("response", (upstreamRes) => {
        out.setTimeout(0);
        finish("ok");
        copyResponse(upstreamRes, res);
      });
      out.on("error", () => finish("error"));
      out.setTimeout(connectTimeoutMs, () => out.destroy(new Error("connect timed out")));

      res.on("close", () => {
        if (!out.destroyed) out.destroy();
      });

      if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") out.end();
      else req.pipe(out);
    });
  }

  function copyResponse(upstreamRes, res) {
    const headers = {};
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (value === undefined) continue;
      if (HOP_BY_HOP.has(key.toLowerCase())) continue;
      headers[key] = value;
    }
    try {
      res.writeHead(upstreamRes.statusCode ?? 502, headers);
    } catch (error) {
      void error;
      res.destroy();
      return;
    }
    upstreamRes.on("error", () => res.destroy());
    upstreamRes.pipe(res);
  }

  return {
    get url() {
      return url;
    },
    listen,
    close,
    setUpstream,
    markUpstreamDown,
    clearUpstream,
    setBypass,
    snapshot,
    state() {
      return { ...state };
    },
  };
}

function sendHttpError(res, status, message) {
  try {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(message),
      connection: "close",
    });
    res.end(message);
  } catch {
    try {
      res.destroy();
    } catch {
      /* the caller is already gone */
    }
  }
}

function replySocket(socket, status, message) {
  if (socket === undefined || socket === null) return;
  try {
    if ((socket.writable ?? true) === true && socket.destroyed !== true) {
      socket.end("HTTP/1.1 " + status + " " + message + "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  } catch {
    try {
      socket.destroy();
    } catch {
      /* the caller is already gone */
    }
  }
  socket.on?.("error", noop);
}
