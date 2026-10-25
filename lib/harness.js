/**
 * Host-side access to the harness package that owns the process-wide outbound
 * proxy policy.
 *
 * `dsh-web-fetch-http` decides between "tunnel through the proxy" and "resolve
 * locally and validate the address" by asking `@deepseek-ai/dsh-http-proxy` for
 * the active policy, and Node's built-in `fetch` uses the dispatcher that this
 * package installs. Installing our relay as that policy is therefore only
 * effective when this module resolves the *same* instance the provider uses.
 *
 * A profile-linked plugin resolves bare `@deepseek-ai/*` imports through the
 * harness's own module interception. Older layouts do not, so every candidate
 * anchor inside the harness tree is tried first; Node de-duplicates ES modules
 * by real path, so any anchor that goes through the harness's node_modules
 * yields the identical instance.
 *
 * @module dsh-proxy-failover/harness
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The package that owns the process-wide outbound proxy policy. */
export const PROXY_PACKAGE = "@deepseek-ai/dsh-http-proxy";

/**
 * Anchor files whose node_modules ancestry reaches the harness's own packages.
 * The files never have to exist; only their directory is used for resolution.
 *
 * @param env - an environment snapshot.
 * @returns candidate anchor paths, most specific first.
 */
export function resolutionAnchors(env) {
  const source = env !== null && typeof env === "object" ? env : process.env;
  const anchors = [];

  const home = source.DSH_HOME;
  if (typeof home === "string" && home.trim() !== "") {
    anchors.push(path.join(home, "profiles", "resolve-anchor.js"));
    if (typeof source.DSH_PROFILE === "string" && source.DSH_PROFILE.trim() !== "") {
      anchors.push(path.join(home, "profiles", source.DSH_PROFILE, "resolve-anchor.js"));
    }
    anchors.push(path.join(home, "profiles", "web", "resolve-anchor.js"));
  }

  if (typeof source.APPDATA === "string" && source.APPDATA.trim() !== "") {
    anchors.push(path.join(source.APPDATA, "dsh-desktop", "harness", "profiles", "web", "resolve-anchor.js"));
  }
  if (typeof process.execPath === "string" && process.execPath !== "") {
    anchors.push(path.join(path.dirname(process.execPath), "resources", "app", "resolve-anchor.js"));
  }
  if (typeof source.LOCALAPPDATA === "string" && source.LOCALAPPDATA.trim() !== "") {
    anchors.push(path.join(source.LOCALAPPDATA, "Programs", "DSH Desktop", "resources", "app", "resolve-anchor.js"));
  }
  try {
    anchors.push(path.join(process.cwd(), "resolve-anchor.js"));
  } catch {
    /* an unavailable cwd is not fatal: the anchored attempts above still run */
  }
  return anchors;
}

/**
 * Import one harness package, preferring anchored resolution.
 *
 * @param specifier - bare package name.
 * @param anchors - resolution anchors, as built by {@link resolutionAnchors}.
 * @returns the module namespace, or undefined when nothing resolved or evaluated.
 */
export async function importHarnessModule(specifier, anchors) {
  for (const anchor of anchors) {
    let resolved;
    try {
      resolved = createRequire(anchor).resolve(specifier);
    } catch {
      continue;
    }
    try {
      return await import(pathToFileURL(resolved).href);
    } catch {
      /* an unloadable candidate must not stop the remaining anchors */
    }
  }
  try {
    return await import(specifier);
  } catch {
    return undefined;
  }
}

/**
 * Require a harness package synchronously, through the same anchors.
 *
 * The settings schema builder publishes a CommonJS build, and settings
 * registration happens synchronously inside a cordis inject callback, so the
 * module has to resolve without awaiting.
 *
 * @param specifier - bare package name.
 * @param anchors - resolution anchors, as built by {@link resolutionAnchors}.
 * @returns the required exports, or undefined when no anchor resolved it.
 */
export function requireHarnessModule(specifier, anchors) {
  for (const anchor of anchors) {
    try {
      return createRequire(anchor)(specifier);
    } catch {
      /* try the next anchor */
    }
  }
  try {
    return createRequire(import.meta.url)(specifier);
  } catch {
    return undefined;
  }
}

/**
 * Load the proxy policy module and check the two functions this plugin needs.
 *
 * @param env - an environment snapshot.
 * @returns `{ ok: true, proxy }` or `{ ok: false, reason }`.
 */
export async function loadHarness(env) {
  const anchors = resolutionAnchors(env);
  const proxy = await importHarnessModule(PROXY_PACKAGE, anchors);
  if (proxy === undefined) return { ok: false, reason: "cannot import " + PROXY_PACKAGE };
  if (typeof proxy.installProxyFromEnvironment !== "function") {
    return { ok: false, reason: PROXY_PACKAGE + " does not export installProxyFromEnvironment" };
  }
  if (typeof proxy.proxyRouteFor !== "function") {
    return { ok: false, reason: PROXY_PACKAGE + " does not export proxyRouteFor" };
  }
  return { ok: true, proxy };
}
