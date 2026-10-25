/**
 * dsh-proxy-failover — host plugin.
 *
 * WHAT IT FIXES
 * -------------
 * A TUN-mode Mihomo/Clash with fake-ip answers every hostname with a synthetic
 * address. `web_fetch` then refuses the request because the address is not
 * public. The usual cure is to give the harness a proxy route: with a route
 * present, `dsh-web-fetch-http` tunnels through the proxy (which resolves the
 * origin itself) and skips the local address check.
 *
 * Installing the *real* local proxy as that route has a side effect: the route
 * is process-wide and outlives the proxy. Close Mihomo and every model request
 * still dials the dead port, fails, and is retried until the turn breaks.
 *
 * This plugin installs a loopback relay as the route instead. The relay always
 * answers, checks the upstream at request time, and falls back to a direct
 * connection inside the same request when the upstream has gone away. Model
 * traffic therefore never retries a dead proxy, while `web_fetch` keeps the
 * proxied route that gets it past fake-ip. A health loop re-enables the proxy
 * when it returns, and loses no established direct tunnels while doing so.
 *
 * SURFACES
 * --------
 *   - `GET  /proxy-failover/status` — read-only live state (trusted host only);
 *   - `POST /proxy-failover/api`    — `{"action":"status"|"redetect"|"configure"}`;
 *   - a `proxy-failover` live settings namespace (`proxy`, `noProxy`) that the
 *     companion Web UI panel edits.
 *
 * FAIL-OPEN
 * ---------
 * `apply` never throws. A missing harness package, a busy port, or a rejected
 * install unwinds everything and leaves the previous dispatcher in place. The
 * HTTP surfaces are optional and never affect routing.
 *
 * @module dsh-proxy-failover
 */
import { createManager } from "./manager.js";
import { DEFAULT_PORTS, normalizeProxyUrl } from "./discover.js";
import { DEFAULT_CONFIG } from "./runtime.js";
import { requireHarnessModule, resolutionAnchors } from "./harness.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "proxy-failover";

/** Read-only live status route. */
export const STATUS_PATH = "/proxy-failover/status";

/** Action route used by the settings panel (status / redetect / configure). */
export const API_PATH = "/proxy-failover/api";

/** Settings namespace shared with the Web UI panel. */
export const SETTINGS_NAMESPACE = "proxy-failover";

/** Package that supplies the settings schema builder. */
const SCHEMA_PACKAGE = "@deepseek-ai/schemastery";

/** Largest action body accepted, in bytes. */
const MAX_BODY_BYTES = 64 * 1024;

const DISABLED_VALUES = ["off", "none", "direct", "disable", "disabled", "false"];

/** A logger that never throws and works with or without a cordis context. */
export function makeLogger(ctx) {
  const logger = ctx !== null && typeof ctx === "object" ? ctx.logger : undefined;
  return function log(level, message) {
    const line = "[" + name + "] " + message;
    try {
      if (logger !== undefined && logger !== null && typeof logger[level] === "function") {
        logger[level](line);
        return;
      }
      if (level === "warn" || level === "error") console.warn(line);
      else console.log(line);
    } catch {
      /* logging must never break routing */
    }
  };
}

function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sendJson(res, statusCode, payload) {
  try {
    res.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(payload));
  } catch {
    try {
      res.end();
    } catch {
      /* the caller is already gone */
    }
  }
}

/** Reject a stored proxy value the host cannot route, before it is persisted. */
export function validateSettings(value) {
  const proxy = value !== null && typeof value === "object" && typeof value.proxy === "string" ? value.proxy.trim() : "auto";
  if (proxy === "" || proxy.toLowerCase() === "auto") return;
  if (DISABLED_VALUES.includes(proxy.toLowerCase())) return;
  if (normalizeProxyUrl(proxy) === undefined) {
    throw new Error("代理地址必须是 http:// 或 https:// URL（或 host:port 简写）");
  }
}

/** Whether the request comes from a loopback or configured trusted authority. */
function isTrustedRequest(req, trustedHosts) {
  const headers = req !== null && typeof req === "object" && req.headers !== null && typeof req.headers === "object" ? req.headers : {};
  const host = typeof headers.host === "string" ? headers.host : "";
  if (host === "") return false;

  let hostname;
  try {
    hostname = new URL("http://" + host).hostname;
  } catch {
    return false;
  }

  const loopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  if (!loopback) {
    const accepted = trustedHosts.some(function (entry) {
      const text = String(entry);
      try {
        return new URL(text.indexOf("//") >= 0 ? text : "http://" + text).hostname === hostname;
      } catch {
        return false;
      }
    });
    if (!accepted) return false;
  }

  if (headers["sec-fetch-site"] === "cross-site") return false;
  const origin = headers.origin;
  if (typeof origin !== "string") return true;
  try {
    return new URL(origin).hostname === hostname;
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise(function (resolve) {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", function (chunk) {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        finish(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", function () {
      finish(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", function () {
      finish(undefined);
    });
  });
}

function createStatusHandler(manager, trustedHosts) {
  return function handler(req, res) {
    if (!isTrustedRequest(req, trustedHosts)) {
      sendJson(res, 403, { ok: false, error: { code: "forbidden" } });
      return;
    }
    if (req.method !== "GET") {
      sendJson(res, 405, { ok: false, error: { code: "method-not-allowed" } });
      return;
    }
    sendJson(res, 200, { ok: true, value: manager.snapshot() });
  };
}

function createApiHandler(manager, trustedHosts, log) {
  return async function handler(req, res) {
    if (!isTrustedRequest(req, trustedHosts)) {
      sendJson(res, 403, { ok: false, error: { code: "forbidden" } });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: { code: "method-not-allowed" } });
      return;
    }

    const raw = await readBody(req);
    let body = {};
    if (typeof raw === "string" && raw !== "") {
      try {
        const parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === "object") body = parsed;
      } catch {
        sendJson(res, 400, { ok: false, error: { code: "invalid-json" } });
        return;
      }
    }
    const action = typeof body.action === "string" ? body.action : "status";

    try {
      if (action === "redetect") {
        await manager.redetect();
      } else if (action === "configure") {
        const next = body.config !== null && typeof body.config === "object" ? body.config : {};
        validateSettings(next);
        const applied = await manager.configure({
          proxy: typeof next.proxy === "string" ? next.proxy : undefined,
          noProxy: typeof next.noProxy === "string" ? next.noProxy : undefined,
        });
        if (applied !== true) {
          sendJson(res, 502, { ok: false, value: manager.snapshot(), error: { code: "apply-failed" } });
          return;
        }
      } else if (action !== "status") {
        sendJson(res, 400, { ok: false, error: { code: "unknown-action" } });
        return;
      }
      sendJson(res, 200, { ok: true, value: manager.snapshot() });
    } catch (error) {
      log("warn", "配置接口失败：" + describe(error));
      sendJson(res, 400, { ok: false, error: { code: "invalid-config", message: describe(error) } });
    }
  };
}

function registerRoutes(ctx, manager, trustedHosts, log) {
  if (ctx === null || typeof ctx !== "object" || typeof ctx.inject !== "function") return;
  try {
    ctx.inject(["webServer"], function (serverCtx) {
      try {
        const statusHandler = createStatusHandler(manager, trustedHosts);
        const apiHandler = createApiHandler(manager, trustedHosts, log);
        serverCtx.effect(function () {
          const disposeStatus = serverCtx.webServer.register({ kind: "exact", path: STATUS_PATH, handler: statusHandler });
          const disposeApi = serverCtx.webServer.register({ kind: "exact", path: API_PATH, handler: apiHandler });
          return function () {
            try {
              disposeApi?.();
            } catch {
              /* best effort */
            }
            try {
              disposeStatus?.();
            } catch {
              /* best effort */
            }
          };
        }, name + ": http surfaces");
      } catch (error) {
        log("warn", "状态接口注册失败：" + describe(error));
      }
    });
  } catch (error) {
    log("warn", "注入 webServer 服务失败：" + describe(error));
  }
}

/**
 * The Loader projects settings namespaces from this Config schema. Only the
 * `.volatile()` fields become editable in Settings; the rest stay deploy-only.
 * The schema is built through a guarded resolver so a profile that cannot
 * resolve schemastery still boots the plugin (without a settings row).
 */
function buildConfigSchema(z) {
  if (z === undefined || typeof z.object !== "function") return undefined;
  try {
    return z.object({
      enabled: z.boolean().default(true),
      proxy: z.string().default(DEFAULT_CONFIG.proxy).description("auto | off | http(s)://host:port").volatile(),
      noProxy: z.string().default(DEFAULT_CONFIG.noProxy).description("comma separated bypass list").volatile(),
      listenHost: z.string().default(DEFAULT_CONFIG.listenHost),
      listenPort: z.number().default(DEFAULT_CONFIG.listenPort),
      probeIntervalMs: z.number().default(DEFAULT_CONFIG.probeIntervalMs),
      probeTimeoutMs: z.number().default(DEFAULT_CONFIG.probeTimeoutMs),
      verifyTimeoutMs: z.number().default(DEFAULT_CONFIG.verifyTimeoutMs),
      connectTimeoutMs: z.number().default(DEFAULT_CONFIG.connectTimeoutMs),
      handshakeTimeoutMs: z.number().default(DEFAULT_CONFIG.handshakeTimeoutMs),
      resolveTimeoutMs: z.number().default(DEFAULT_CONFIG.resolveTimeoutMs),
      candidatePorts: z.array(z.number()).default([...DEFAULT_PORTS]),
    });
  } catch {
    return undefined;
  }
}

/** Settings schema for the plugin row; undefined when schemastery is unavailable. */
export const Config = buildConfigSchema(requireHarnessModule(SCHEMA_PACKAGE, resolutionAnchors(process.env)));

/**
 * Cordis entry point. Never throws.
 *
 * @param ctx - the cordis context.
 * @param config - the row config.
 */
export async function apply(ctx, config) {
  const log = makeLogger(ctx);
  const manager = createManager({ config, log });

  try {
    const started = await manager.start();
    if (started !== true) {
      log("warn", "首次启动失败；设置页面仍可用来修改配置（现有网络不受影响）。");
    }
  } catch (error) {
    log("warn", "启动失败，保持宿主原有路由：" + describe(error));
  }

  const cleanup = () => {
    void manager.dispose().catch((error) => log("warn", "停止失败：" + describe(error)));
  };

  if (ctx !== null && typeof ctx === "object" && typeof ctx.effect === "function") {
    try {
      ctx.effect(() => cleanup, name + ": runtime and proxy policy");
    } catch (error) {
      log("warn", "注册生命周期清理失败：" + describe(error));
      cleanup();
      return;
    }
  } else {
    cleanup();
    return;
  }

  // Accessing an undeclared cordis service throws, so this surface stays
  // loopback-only. The Web UI panel is normally opened at 127.0.0.1; its
  // settings RPC is authenticated separately by the harness.
  const trustedHosts = [];
  registerRoutes(ctx, manager, trustedHosts, log);

  // A volatile settings edit mutates the Config object in place and emits this
  // event; apply it to the relay without remounting the plugin or the route.
  try {
    ctx.on("loader/volatile-update", (paths) => {
      void paths;
      const read = (name) => {
        const value = config?.[name];
        if (value !== null && typeof value === "object" && typeof value.get === "function") return value.get();
        return value;
      };
      void manager.configure({
        proxy: typeof read("proxy") === "string" ? read("proxy") : undefined,
        noProxy: typeof read("noProxy") === "string" ? read("noProxy") : undefined,
      });
    });
  } catch (error) {
    log("warn", "注册设置更新监听失败：" + describe(error));
  }
}

export { createManager } from "./manager.js";
export { startRuntime } from "./runtime.js";
export { createRelay, isBlockedAddress } from "./relay.js";
export { createAddressResolver } from "./resolve.js";
export { collectCandidates, normalizeProxyUrl, probeTcp, scanCandidates, verifyHttpProxy } from "./discover.js";
