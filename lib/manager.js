/**
 * Live configuration owner for dsh-proxy-failover.
 *
 * One manager keeps the deploy row config, the settings-service overlay, and the
 * currently installed runtime consistent. Every reconfiguration is serialized:
 * the previous runtime is disposed (which restores the previous dispatcher and
 * waits for in-flight requests), then a new runtime starts. If the new start
 * fails, the previous configuration is started again, so a bad edit never leaves
 * the process without a route.
 *
 * @module dsh-proxy-failover/manager
 */
import { normalizeConfig, startRuntime } from "./runtime.js";

function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sameConfig(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Create the live configuration manager.
 *
 * @param options - deploy config, logger and a startRuntime seam for tests.
 * @returns start/configure/redetect/snapshot/dispose.
 */
export function createManager(options) {
  const opts = options !== null && typeof options === "object" ? options : {};
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const start = typeof opts.startRuntime === "function" ? opts.startRuntime : startRuntime;

  let current = normalizeConfig(opts.config);
  let runtime;
  let disposed = false;
  let queue = Promise.resolve();

  const configSnapshot = () => ({ ...current });

  async function launch(next, previous) {
    const result = await start({ config: next, log });
    if (result !== undefined && result.ok === true) {
      runtime = result;
      current = next;
      return true;
    }
    log("warn", "按新配置启动失败，保持原配置：" + (result?.reason ?? "unknown"));
    if (previous !== undefined) {
      const fallback = await start({ config: previous, log });
      if (fallback !== undefined && fallback.ok === true) {
        runtime = fallback;
        current = previous;
        log("info", "已回退到上一份可用配置。");
        return false;
      }
    }
    runtime = undefined;
    return false;
  }

  return {
    /** Install the deploy configuration once. */
    async start() {
      if (disposed) return false;
      if (runtime !== undefined) return true;
      return await launch(current, undefined);
    },

    /**
     * Merge a partial config and apply it in place; never rejects.
     *
     * A running relay is updated, not reinstalled: the dispatcher, the tunnel
     * pool, and the current model stream are all left exactly where they are.
     */
    configure(partial) {
      const patch = partial !== null && typeof partial === "object" ? partial : {};
      queue = queue.then(async () => {
        if (disposed) return false;
        const next = normalizeConfig({ ...current, ...patch });
        if (runtime === undefined) {
          const previous = current;
          current = next;
          return await launch(next, previous);
        }
        if (sameConfig(next, current)) return true;
        try {
          const applied = await runtime.reconfigure(patch);
          if (applied === true) {
            current = next;
            return true;
          }
          return false;
        } catch (error) {
          log("warn", "应用配置失败：" + describe(error));
          return false;
        }
      }).catch((error) => {
        log("warn", "应用配置失败：" + describe(error));
        return false;
      });
      return queue;
    },

    /** Re-scan the upstream proxy without a full restart. */
    async redetect() {
      await queue;
      if (disposed || runtime === undefined) return false;
      try {
        await runtime.tick();
        return true;
      } catch (error) {
        log("warn", "重新检测失败：" + describe(error));
        return false;
      }
    },

    /** Live status for the HTTP surface. */
    snapshot() {
      if (runtime === undefined) {
        return {
          installed: false,
          plugin: "dsh-proxy-failover",
          routed: false,
          proxy: configSnapshot(),
        };
      }
      return runtime.snapshot();
    },

    /** The configuration currently in force. */
    config: configSnapshot,

    /** Stop accepting settings changes, then dispose the runtime. */
    async dispose() {
      if (disposed) return;
      disposed = true;
      // A queued configure may be waiting on a long-lived model stream; do not
      // let plugin teardown hang on it.
      await Promise.race([
        queue.catch(() => {}),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 2_000);
          timer.unref?.();
        }),
      ]);
      const old = runtime;
      runtime = undefined;
      if (old !== undefined) {
        try {
          await old.dispose();
        } catch (error) {
          log("warn", "停止运行时失败：" + describe(error));
        }
      }
    },
  };
}
