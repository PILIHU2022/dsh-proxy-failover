/**
 * Runtime assembly for dsh-proxy-failover.
 *
 * One object owns the pieces that must stay consistent:
 *
 *   - the loopback relay (the stable proxy target the harness installs);
 *   - the ranked upstream candidate list, captured from the launch environment
 *     *before* the policy is installed (installing it rewrites that environment);
 *   - the installed process-wide policy plus the disposer that restores the
 *     previous dispatcher and environment;
 *   - the health loop that re-enables an upstream after it comes back.
 *
 * Live configuration changes never reinstall the policy: `reconfigure` updates
 * the relay's upstream and bypass list in place. That keeps the dispatcher and
 * every established tunnel exactly where they are, so editing settings cannot
 * interrupt a running model stream or leave a stale proxy environment behind.
 *
 * @module dsh-proxy-failover/runtime
 */
import { DEFAULT_PORTS, collectCandidates, normalizeProxyUrl, probeTcp, scanCandidates } from "./discover.js";
import { loadHarness } from "./harness.js";
import { createRelay } from "./relay.js";

/** Deployment defaults; every field can be overridden by the cordis row config. */
export const DEFAULT_CONFIG = {
  enabled: true,
  proxy: "auto",
  noProxy: "",
  listenHost: "127.0.0.1",
  listenPort: 0,
  probeIntervalMs: 1_500,
  probeTimeoutMs: 400,
  verifyTimeoutMs: 1_500,
  connectTimeoutMs: 10_000,
  handshakeTimeoutMs: 10_000,
  resolveTimeoutMs: 5_000,
  candidatePorts: DEFAULT_PORTS,
};

const DISABLED_VALUES = ["off", "none", "direct", "disable", "disabled", "false"];

/** Names `@deepseek-ai/dsh-http-proxy` publishes; also the names this plugin restores on failure. */
const PROXY_ENV_NAMES = ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "no_proxy", "NO_PROXY"];

function snapshotProxyEnv(env) {
  const snapshot = {};
  for (const name of PROXY_ENV_NAMES) snapshot[name] = env[name];
  return snapshot;
}

function restoreProxyEnv(env, snapshot) {
  for (const name of PROXY_ENV_NAMES) {
    const value = snapshot[name];
    if (value === undefined) Reflect.deleteProperty(env, name);
    else env[name] = value;
  }
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Volatile schemastery fields resolve to `{ get() }` refs; ordinary fields are plain. */
function unwrap(value) {
  if (value !== null && typeof value === "object" && typeof value.get === "function") return value.get();
  return value;
}

function isLoopbackHost(host) {
  const value = String(host).trim().toLowerCase();
  return value === "127.0.0.1" || value === "localhost" || value === "::1" || value === "[::1]";
}

/**
 * Normalize a raw cordis config object; every field is optional and clamped.
 *
 * @param raw - the row's config value.
 * @returns a complete configuration.
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const proxyValue = unwrap(source.proxy);
  const noProxyValue = unwrap(source.noProxy);
  const listenHostValue = unwrap(source.listenHost);
  const portsValue = unwrap(source.candidatePorts);
  const proxy = typeof proxyValue === "string" && proxyValue.trim() !== "" ? proxyValue.trim() : DEFAULT_CONFIG.proxy;
  const listenHost = typeof listenHostValue === "string" && isLoopbackHost(listenHostValue) ? listenHostValue.trim() : DEFAULT_CONFIG.listenHost;
  const ports = Array.isArray(portsValue) && portsValue.length > 0 ? portsValue : DEFAULT_CONFIG.candidatePorts;
  return {
    enabled: unwrap(source.enabled) !== false,
    proxy,
    noProxy: typeof noProxyValue === "string" ? noProxyValue.trim() : "",
    listenHost,
    listenPort: Number.isInteger(unwrap(source.listenPort)) && unwrap(source.listenPort) >= 0 && unwrap(source.listenPort) <= 65535 ? unwrap(source.listenPort) : 0,
    probeIntervalMs: clampInt(unwrap(source.probeIntervalMs), 500, 600_000, DEFAULT_CONFIG.probeIntervalMs),
    probeTimeoutMs: clampInt(unwrap(source.probeTimeoutMs), 50, 30_000, DEFAULT_CONFIG.probeTimeoutMs),
    verifyTimeoutMs: clampInt(unwrap(source.verifyTimeoutMs), 100, 30_000, DEFAULT_CONFIG.verifyTimeoutMs),
    connectTimeoutMs: clampInt(unwrap(source.connectTimeoutMs), 500, 120_000, DEFAULT_CONFIG.connectTimeoutMs),
    handshakeTimeoutMs: clampInt(unwrap(source.handshakeTimeoutMs), 500, 120_000, DEFAULT_CONFIG.handshakeTimeoutMs),
    resolveTimeoutMs: clampInt(unwrap(source.resolveTimeoutMs), 500, 60_000, DEFAULT_CONFIG.resolveTimeoutMs),
    candidatePorts: ports,
  };
}

/** Merge the user's bypass list with the environment's, dropping duplicates. */
function collectBypass(env, extra) {
  const parts = [];
  for (const name of ["NO_PROXY", "no_proxy"]) {
    const value = env[name];
    if (typeof value === "string" && value.trim() !== "") parts.push(value.trim());
  }
  if (typeof extra === "string" && extra.trim() !== "") parts.push(extra.trim());
  const seen = new Set();
  const merged = [];
  for (const part of parts.join(",").split(",")) {
    const entry = part.trim();
    if (entry === "" || seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }
  return merged.length === 0 ? undefined : merged.join(",");
}

/** The public configuration echoed by the status surface (never a credential). */
function publicConfig(config) {
  return {
    enabled: config.enabled,
    proxy: config.proxy,
    noProxy: config.noProxy,
    listenHost: config.listenHost,
    listenPort: config.listenPort,
    probeIntervalMs: config.probeIntervalMs,
    probeTimeoutMs: config.probeTimeoutMs,
    candidatePorts: config.candidatePorts,
  };
}

/**
 * Start the relay, install it as the process proxy policy, and start health
 * probing.
 *
 * @param options - config, logger and test seams.
 * @returns a runtime handle, or `{ ok: false, reason }` with nothing installed.
 */
export async function startRuntime(options) {
  const opts = options !== null && typeof options === "object" ? options : {};
  let currentConfig = normalizeConfig(opts.config);
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const env = opts.env !== null && typeof opts.env === "object" ? opts.env : process.env;
  const harnessLoader = typeof opts.loadHarness === "function" ? opts.loadHarness : loadHarness;

  if (currentConfig.enabled !== true) return { ok: false, reason: "disabled by config" };

  const harness = await harnessLoader(env);
  if (harness.ok !== true) return { ok: false, reason: harness.reason };

  // Discovery must see the launch environment, not the relay this plugin is
  // about to publish into process.env.
  const envAtStart = { ...env };
  const relay = createRelay({
    log,
    connectTimeoutMs: currentConfig.connectTimeoutMs,
    handshakeTimeoutMs: currentConfig.handshakeTimeoutMs,
    resolveTimeoutMs: currentConfig.resolveTimeoutMs,
    resolver: opts.resolver,
  });

  let release;
  let timer;
  let disposed = false;
  let candidates = [];
  let cache = new Map();
  const previousMarker = env.DSH_PROXY_FAILOVER_RELAY;
  const envBeforeInstall = snapshotProxyEnv(process.env);

  const computeCandidates = (config) => {
    if (DISABLED_VALUES.includes(config.proxy.toLowerCase())) return [];
    let setting = config.proxy;
    if (setting.toLowerCase() !== "auto" && normalizeProxyUrl(setting) === undefined) {
      log("warn", "proxy 配置 \"" + config.proxy + "\" 不是有效的 HTTP(S) 代理地址，改用 auto 自动发现。");
      setting = "auto";
    }
    return collectCandidates({
      proxy: setting,
      env: envAtStart,
      ports: config.candidatePorts,
      home: opts.home,
      appData: opts.appData,
      localAppData: opts.localAppData,
      clashFiles: opts.clashFiles,
    });
  };

  const scan = () =>
    scanCandidates(candidates, {
      probeTimeoutMs: currentConfig.probeTimeoutMs,
      verifyTimeoutMs: currentConfig.verifyTimeoutMs,
      cache,
      log,
    });

  /** Bring the relay's upstream in line with `currentConfig`. */
  async function applyUpstream() {
    if (DISABLED_VALUES.includes(currentConfig.proxy.toLowerCase())) {
      relay.clearUpstream("已配置为直连", false);
      return;
    }
    if (candidates.length === 0) {
      if (relay.snapshot().upstreamUp === true) relay.markUpstreamDown("没有可用的上游候选");
      relay.clearUpstream("未发现可用的本地代理", false);
      return;
    }
    const found = await scan();
    if (found !== undefined) {
      relay.setUpstream(found);
      return;
    }
    if (relay.snapshot().upstreamUp === true) relay.markUpstreamDown("未找到可用的本地代理");
    relay.clearUpstream("未找到可用的本地代理", false);
  }

  try {
    await relay.listen(currentConfig.listenHost, currentConfig.listenPort);
    const relayUrl = relay.url;
    candidates = computeCandidates(currentConfig);
    relay.setBypass(collectBypass(envAtStart, currentConfig.noProxy));
    await applyUpstream();
    if (relay.snapshot().upstreamUp === false) {
      log("info", "未发现可用的本地代理；请求将直连（TUN fake-ip 下仍可正常出网）。");
    }

    const bypass = collectBypass(envAtStart, currentConfig.noProxy);
    const values = {
      http_proxy: relayUrl,
      https_proxy: relayUrl,
      HTTP_PROXY: relayUrl,
      HTTPS_PROXY: relayUrl,
    };
    if (bypass !== undefined) {
      values.no_proxy = bypass;
      values.NO_PROXY = bypass;
    }
    const snapshot = {
      get(name) {
        const value = values[name];
        return value === undefined ? undefined : { value };
      },
    };
    const diagnostics = [];
    release = await harness.proxy.installProxyFromEnvironment(snapshot, (message) => {
      diagnostics.push(String(message));
    });
    for (const message of diagnostics) log("warn", "代理策略诊断：" + message);

    env.DSH_PROXY_FAILOVER_RELAY = relayUrl;

    const checkUrl = new URL("https://proxy-failover-check.invalid/");
    const route = harness.proxy.proxyRouteFor(checkUrl);
    const routed = route !== undefined && route.proxied === true && route.proxy === relayUrl;
    if (!routed) {
      log("warn", "宿主没有把全局请求路由到本插件的 relay；请检查 no_proxy 是否覆盖了全部目标。");
    }

    log("info", "代理容错 relay 已就绪：" + relayUrl + (relay.snapshot().upstreamUp === true ? "（当前经 " + relay.snapshot().upstream?.url + "）" : "（当前直连）"));

    let ticking = false;

    async function tick() {
      if (disposed || ticking) return;
      ticking = true;
      try {
        const current = relay.snapshot();
        if (current.upstream !== undefined && current.upstreamUp === true) {
          const alive = await probeTcp(current.upstream.hostname, current.upstream.port, currentConfig.probeTimeoutMs);
          if (alive || disposed) return;
          relay.markUpstreamDown("探活失败：端口无响应");
        }
        if (disposed || candidates.length === 0) return;
        const found = await scan();
        if (!disposed && found !== undefined) relay.setUpstream(found);
      } finally {
        ticking = false;
      }
    }

    function scheduleProbe() {
      if (timer !== undefined) clearInterval(timer);
      timer = setInterval(() => {
        void tick().catch((error) => log("warn", "代理探活失败：" + describe(error)));
      }, currentConfig.probeIntervalMs);
      timer.unref?.();
    }
    scheduleProbe();

    async function reconfigure(partial) {
      if (disposed) return false;
      const next = normalizeConfig({ ...currentConfig, ...(partial !== null && typeof partial === "object" ? partial : {}) });
      const intervalChanged = next.probeIntervalMs !== currentConfig.probeIntervalMs;
      currentConfig = next;
      candidates = computeCandidates(next);
      cache = new Map();
      relay.setBypass(collectBypass(envAtStart, next.noProxy));
      if (intervalChanged) scheduleProbe();
      await applyUpstream();
      return true;
    }

    async function dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearInterval(timer);
      if (release !== undefined) {
        // The disposer restores the dispatcher and environment synchronously,
        // then waits for the old agent's live tunnels to close. Awaiting that
        // wait would stall a settings change for as long as a model stream is
        // open, so restore first and let the old agent drain in the background.
        const pending = release;
        release = undefined;
        try {
          const draining = pending();
          if (draining !== undefined && typeof draining.catch === "function") {
            draining.catch((error) => log("warn", "旧的代理策略释放失败：" + describe(error)));
          }
        } catch (error) {
          log("warn", "恢复原有代理策略失败：" + describe(error));
        }
      }
      if (env.DSH_PROXY_FAILOVER_RELAY !== undefined) {
        if (previousMarker === undefined) Reflect.deleteProperty(env, "DSH_PROXY_FAILOVER_RELAY");
        else env.DSH_PROXY_FAILOVER_RELAY = previousMarker;
      }
      await relay.close();
      log("info", "代理容错 relay 已停止。");
    }

    return {
      ok: true,
      get config() {
        return { ...currentConfig };
      },
      relay,
      get candidates() {
        return candidates;
      },
      routed,
      snapshot() {
        return {
          installed: true,
          plugin: "dsh-proxy-failover",
          routed,
          relay: relay.snapshot(),
          proxy: publicConfig(currentConfig),
          candidates: candidates.map((candidate) => ({
            url: candidate.url,
            source: candidate.source,
            trusted: candidate.trusted === true,
          })),
        };
      },
      reconfigure,
      dispose,
      tick,
    };
  } catch (error) {
    if (release !== undefined) {
      try {
        await release();
      } catch {
        /* best effort */
      }
    }
    // A policy install that throws after publishing the environment leaves no
    // disposer; restore the names we knew about so the failure is truly fail-open.
    restoreProxyEnv(process.env, envBeforeInstall);
    await relay.close();
    return { ok: false, reason: describe(error) };
  }
}
