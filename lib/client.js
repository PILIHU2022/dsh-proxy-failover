/**
 * dsh-proxy-failover — Web settings panel (client half).
 *
 * Adds one row to Settings → General. The row is a thin surface over two host
 * facts that this plugin already owns:
 *
 *   GET  /proxy-failover/status   live relay/upstream snapshot (loopback)
 *   POST /proxy-failover/api      { action: "status" | "redetect" }
 *
 * Writes go through the generated Remote settings namespace
 * (`proxy-failover`, fields `proxy` and `noProxy`) using the same
 * describe → mutate(revision) flow as `dsh-web-fetch-proxy`:
 *
 *   ctx.remote.settings.describe()
 *   ctx.remote.settings.mutate("proxy-failover", ops, view.revision)
 *
 * The host registers the namespace with `applies: "live"`, so a successful
 * write takes effect without a restart. Every failure path is swallowed: an
 * absent namespace, an unreachable status route, a 403/404 on the action
 * endpoint, or a rejected save only changes copy in the row.
 *
 * No build step: DSH serves this file through the client module graph
 * (`dsh.client` + `exports["./client"]`) and executes it with
 * `window.__ModuleLoader__.load({ id, factory })`.
 *
 * @module dsh-proxy-failover/client
 */
window.__ModuleLoader__.load({
  id: "dsh-proxy-failover",
  factory: (require) => {
    const module = { exports: {} };
    const React = require("react");
    const { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

    const LOCALE_NS = "settings.proxyFailover";
    const SETTINGS_NS = "proxy-failover";
    const STATUS_PATH = "/proxy-failover/status";
    const API_PATH = "/proxy-failover/api";
    const POLL_MS = 5000;
    const REQUEST_TIMEOUT_MS = 8000;
    const REDETECT_TIMEOUT_MS = 15000;

    const MODE_AUTO = "auto";
    const MODE_OFF = "off";
    const MODE_MANUAL = "manual";

    const styles =
      ".dshPfRow{border-bottom:1px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:14px;padding:16px 0}" +
      ".dshPfHeader{display:flex;align-items:flex-start;gap:24px}" +
      ".dshPfCopy{display:flex;flex:1;min-width:0;flex-direction:column;gap:4px}" +
      ".dshPfTitle{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}" +
      ".dshPfDesc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}" +
      ".dshPfModes{display:grid;grid-template-columns:repeat(3,minmax(76px,1fr));flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:2px;background:var(--dsw-alias-bg-module-platform)}" +
      ".dshPfMode{height:30px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}" +
      ".dshPfMode:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}" +
      ".dshPfMode[data-active=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.08)}" +
      ".dshPfMode:disabled{cursor:default;opacity:.6}" +
      ".dshPfPanel{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:10px;padding:12px 14px}" +
      ".dshPfPanelHead{display:flex;align-items:center;gap:10px;min-height:26px}" +
      ".dshPfState{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}" +
      ".dshPfDot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}" +
      ".dshPfState[data-state=up] .dshPfDot{background:var(--dsw-alias-state-success-primary)}" +
      ".dshPfState[data-state=direct] .dshPfDot{background:var(--dsw-alias-state-warn-primary)}" +
      ".dshPfState[data-state=down] .dshPfDot{background:var(--dsw-alias-state-error-primary)}" +
      ".dshPfGhost{flex:none;margin-left:auto;height:26px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:0 10px;cursor:pointer}" +
      ".dshPfGhost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}" +
      ".dshPfGhost:disabled{cursor:default;opacity:.55}" +
      ".dshPfFacts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 18px}" +
      ".dshPfFact{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:12px;line-height:18px}" +
      ".dshPfFact[data-wide=true]{grid-column:1/-1;align-items:flex-start}" +
      ".dshPfFactLabel{flex:none;color:var(--dsw-alias-label-tertiary)}" +
      ".dshPfFactValue{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}" +
      ".dshPfFactValue[data-mono=true]{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}" +
      ".dshPfFactValue[data-error=true]{color:var(--dsw-alias-label-error);overflow:visible;white-space:pre-wrap;overflow-wrap:anywhere}" +
      ".dshPfNote{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}" +
      ".dshPfNote[data-error=true]{color:var(--dsw-alias-state-error-primary)}" +
      ".dshPfStack{display:flex;flex-direction:column;gap:6px}" +
      ".dshPfField{display:flex;align-items:center;gap:8px}" +
      ".dshPfLabel{flex:none;width:88px;color:var(--dsw-alias-label-secondary);font-size:13px}" +
      ".dshPfInput{box-sizing:border-box;flex:1;min-width:0;height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:0 11px;font:inherit;font-size:13px;outline:none}" +
      ".dshPfInput:focus{border-color:var(--dsw-alias-border-l4)}" +
      ".dshPfInput::placeholder{color:var(--dsw-alias-label-dimmed)}" +
      ".dshPfApply{flex:none;height:36px;border:0;border-radius:var(--dsw-radius-md);padding:0 14px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:13px;cursor:pointer}" +
      ".dshPfApply:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}" +
      ".dshPfApply:disabled{cursor:default;opacity:.55}" +
      ".dshPfHint{color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px}" +
      "@media(max-width:680px){.dshPfHeader{flex-direction:column;gap:12px}.dshPfModes{width:100%}.dshPfFacts{grid-template-columns:minmax(0,1fr)}.dshPfField{flex-wrap:wrap}.dshPfLabel{width:100%}.dshPfInput{flex-basis:100%}.dshPfApply{width:100%}}";

    const zh = {
      title: "代理容错出网",
      description: "让 web_fetch 经本地代理出网以绕过 TUN fake-ip；代理失效时自动直连，保存后立即生效。",
      auto: "自动检测",
      manual: "手动代理",
      off: "关闭",
      manualPlaceholder: "http://127.0.0.1:7890",
      bypass: "绕过列表",
      bypassPlaceholder: "localhost,.internal",
      apply: "应用",
      save: "保存",
      saving: "正在应用...",
      checking: "正在检测...",
      redetect: "重新检测",
      relay: "中继地址",
      upstream: "上游代理",
      source: "来源",
      requests: "请求次数",
      fallbacks: "回退次数",
      lastError: "最近错误",
      connected: "已连接",
      direct: "已直连",
      unknown: "状态未知",
      noUpstream: "无（直连）",
      statusUnavailable: "状态接口不可达，显示的是最近一次结果",
      redetectUnavailable: "重新检测接口不可用（需要宿主提供 POST /proxy-failover/api），已改为刷新当前状态",
      settingsUnavailable: "设置暂不可用：宿主尚未注册 proxy-failover 设置命名空间",
      settingsError: "设置读取失败",
      saveFailed: "保存失败",
      readOnly: "当前配置文件只读，无法保存",
      manualInvalid: "请输入以 http:// 或 https:// 开头的代理地址",
    };
    const en = {
      title: "Failover Egress",
      description: "Route web_fetch through a local proxy to bypass TUN fake-ip, then fall back to direct connections when the proxy stops. Changes apply immediately.",
      auto: "Auto-detect",
      manual: "Manual proxy",
      off: "Off",
      manualPlaceholder: "http://127.0.0.1:7890",
      bypass: "Bypass list",
      bypassPlaceholder: "localhost,.internal",
      apply: "Apply",
      save: "Save",
      saving: "Applying...",
      checking: "Checking...",
      redetect: "Re-detect",
      relay: "Relay",
      upstream: "Upstream",
      source: "Via",
      requests: "Requests",
      fallbacks: "Fallbacks",
      lastError: "Last error",
      connected: "Connected",
      direct: "Direct",
      unknown: "Status unknown",
      noUpstream: "None (direct)",
      statusUnavailable: "Status endpoint unreachable — showing the last known result",
      redetectUnavailable: "Re-detect endpoint unavailable (host must provide POST /proxy-failover/api); refreshed the current status instead",
      settingsUnavailable: "Settings unavailable: the host has not registered the proxy-failover settings namespace",
      settingsError: "Could not read settings",
      saveFailed: "Could not save",
      readOnly: "This profile is read-only",
      manualInvalid: "Enter a proxy URL starting with http:// or https://",
    };

    function isRecord(value) {
      return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function textOf(value) {
      return typeof value === "string" ? value : undefined;
    }

    function countOf(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return 0;
      return value > 0 ? Math.trunc(value) : 0;
    }

    function errorText(error) {
      if (error === undefined || error === null) return "request failed";
      if (typeof error === "string") return error;
      if (isRecord(error)) {
        if (typeof error.message === "string" && error.message.length > 0) return error.message;
        if (typeof error.code === "string" && error.code.length > 0) return error.code;
      }
      if (error instanceof Error) return error.message;
      return String(error);
    }

    function failureText(response, payload) {
      const error = isRecord(payload) ? payload.error : undefined;
      if (error !== undefined) {
        const text = errorText(error);
        if (text.length > 0 && text !== "request failed") return text;
      }
      const status = response && typeof response.status === "number" ? response.status : undefined;
      return status === undefined ? "request failed" : "HTTP " + String(status);
    }

    function modeOf(proxy) {
      const text = typeof proxy === "string" ? proxy.trim() : "";
      if (text === "" || text.toLowerCase() === MODE_AUTO) return MODE_AUTO;
      const lower = text.toLowerCase();
      if (lower === MODE_OFF || lower === "none" || lower === "direct") return MODE_OFF;
      return MODE_MANUAL;
    }

    function isHttpProxyUrl(text) {
      if (typeof text !== "string" || text.trim() === "") return false;
      try {
        const url = new URL(text.trim());
        return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
      } catch (error) {
        return false;
      }
    }

    function normalizeRuntime(value) {
      const root = isRecord(value) ? value : {};
      const relay = isRecord(root.relay) ? root.relay : {};
      const upstream = isRecord(relay.upstream) ? relay.upstream : {};
      const listen = textOf(relay.listen);
      const upstreamUrl = textOf(upstream.url);
      const source = textOf(upstream.source);
      const lastError = textOf(relay.lastError);
      const port = typeof upstream.port === "number" && Number.isFinite(upstream.port) ? upstream.port : undefined;
      return {
        installed: root.installed === true,
        routed: root.routed === true,
        listen: listen !== undefined && listen !== "" ? listen : undefined,
        requests: countOf(relay.requests),
        fallbacks: countOf(relay.fallbacks),
        lastFallbackAt: countOf(relay.lastFallbackAt),
        upstream: upstreamUrl !== undefined && upstreamUrl !== ""
          ? {
              url: upstreamUrl,
              source: source !== undefined && source !== "" ? source : undefined,
              hostname: textOf(upstream.hostname),
              port: port,
            }
          : null,
        upstreamUp: relay.upstreamUp === true,
        lastError: lastError !== undefined && lastError !== "" ? lastError : null,
        checkedAt: countOf(relay.checkedAt),
      };
    }

    async function fetchJson(path, init, timeoutMs) {
      if (typeof fetch !== "function") throw new Error("fetch unavailable");
      const controller = typeof AbortController === "function" ? new AbortController() : undefined;
      const timer = controller !== undefined && typeof setTimeout === "function"
        ? setTimeout(() => {
            try {
              controller.abort();
            } catch (error) {
              /* abort is best-effort */
            }
          }, timeoutMs)
        : undefined;
      try {
        const request = Object.assign(
          {
            credentials: "same-origin",
            cache: "no-store",
            headers: { accept: "application/json" },
          },
          init,
        );
        if (controller !== undefined) request.signal = controller.signal;
        const response = await fetch(path, request);
        let payload;
        try {
          payload = typeof response.json === "function" ? await response.json() : undefined;
        } catch (error) {
          payload = undefined;
        }
        return { response, payload };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    class ProxyFailoverController {
      constructor(remote) {
        this.remote = remote;
        this.view = undefined;
        this.settingsGeneration = 0;
        this.statusGeneration = 0;
        this.pollTimer = undefined;
        this.disposed = false;
        this.onVisibility = () => {
          if (typeof document !== "undefined" && document.visibilityState !== "hidden") {
            this.maybeRefresh();
          }
        };
        this.store = createSnapshotStore({
          /** Settings namespace read state: loading | ready | saving | unavailable | error. */
          settings: "loading",
          error: null,
          writable: false,
          mode: MODE_AUTO,
          proxy: MODE_AUTO,
          url: "",
          noProxy: "",
          revision: 0,
          /** Set when the host action endpoint is absent / refused the re-detect POST. */
          redetectNote: null,
          runtime: {
            loading: true,
            available: false,
            value: null,
            error: null,
            updatedAt: 0,
          },
        });
      }

      /** Refresh both halves; safe to call repeatedly. */
      load() {
        void this.loadSettings();
        void this.refreshStatus();
      }

      async loadSettings() {
        const generation = ++this.settingsGeneration;
        const snapshot = this.store.getSnapshot();
        if (snapshot.settings !== "ready") {
          this.store.update((state) => {
            state.settings = "loading";
            state.error = null;
          });
        }
        try {
          const api = this.remote !== null && typeof this.remote === "object" ? this.remote.settings : undefined;
          if (api === undefined || api === null || typeof api.describe !== "function") {
            throw new Error("client settings API unavailable");
          }
          const response = await api.describe();
          if (generation !== this.settingsGeneration || this.disposed) return;
          if (!response || response.ok !== true) throw new Error(errorText(response && response.error));
          const described = isRecord(response.value) ? response.value : {};
          const namespaces = Array.isArray(described.namespaces) ? described.namespaces : [];
          const view = namespaces.find((entry) => isRecord(entry) && entry.ns === SETTINGS_NS);
          if (view === undefined) {
            this.view = undefined;
            this.store.update((state) => {
              state.settings = "unavailable";
              state.writable = false;
              state.error = null;
            });
            return;
          }
          this.accept(view, described.writable === true);
        } catch (error) {
          if (generation !== this.settingsGeneration || this.disposed) return;
          this.view = undefined;
          this.store.update((state) => {
            state.settings = "error";
            state.writable = false;
            state.error = errorText(error);
          });
        }
      }

      /** Persist one or two schema fields through the Remote settings namespace. */
      async save(patch) {
        const snapshot = this.store.getSnapshot();
        if (!this.view || snapshot.settings !== "ready" || snapshot.writable !== true) return;
        if (typeof patch.proxy === "string" && modeOf(patch.proxy) === MODE_MANUAL && !isHttpProxyUrl(patch.proxy)) return;
        const generation = ++this.settingsGeneration;
        this.store.update((state) => {
          state.settings = "saving";
          state.error = null;
        });
        try {
          const api = this.remote !== null && typeof this.remote === "object" ? this.remote.settings : undefined;
          if (api === undefined || api === null || typeof api.mutate !== "function") {
            throw new Error("client settings API unavailable");
          }
          const ops = Object.keys(patch).map((key) => ({ op: "set", path: [key], value: patch[key] }));
          const response = await api.mutate(SETTINGS_NS, ops, this.view.revision);
          if (generation !== this.settingsGeneration || this.disposed) return;
          if (!response || response.ok !== true) throw new Error(errorText(response && response.error));
          if (isRecord(response.value)) {
            this.accept(response.value, true);
          } else {
            await this.loadSettings();
          }
          void this.refreshStatus();
          setTimeout(() => {
            if (!this.disposed) void this.refreshStatus();
          }, 1500);
        } catch (error) {
          if (generation !== this.settingsGeneration || this.disposed) return;
          this.store.update((state) => {
            state.settings = "ready";
            state.error = errorText(error);
          });
        }
      }

      /** GET the live relay snapshot. Keeps the last value when the route is absent. */
      async refreshStatus() {
        if (this.disposed) return;
        const generation = ++this.statusGeneration;
        this.store.update((state) => {
          state.runtime = Object.assign({}, state.runtime, { loading: true });
        });
        try {
          const { response, payload } = await fetchJson(
            STATUS_PATH,
            { method: "GET" },
            REQUEST_TIMEOUT_MS,
          );
          if (generation !== this.statusGeneration || this.disposed) return;
          if (!response || response.ok !== true || !isRecord(payload) || payload.ok !== true) {
            throw new Error(failureText(response, payload));
          }
          const value = normalizeRuntime(payload.value);
          this.store.update((state) => {
            state.runtime = {
              loading: false,
              available: true,
              value,
              error: null,
              updatedAt: Date.now(),
            };
          });
        } catch (error) {
          if (generation !== this.statusGeneration || this.disposed) return;
          this.store.update((state) => {
            state.runtime = Object.assign({}, state.runtime, {
              loading: false,
              available: false,
              error: errorText(error),
              updatedAt: Date.now(),
            });
          });
        }
      }

      /**
       * Ask the host to re-scan candidates, then re-read the status snapshot.
       * The action route may not exist yet (403/404); that only sets a note.
       */
      async redetect() {
        if (this.disposed) return;
        const generation = ++this.statusGeneration;
        this.store.update((state) => {
          state.runtime = Object.assign({}, state.runtime, { loading: true });
          state.redetectNote = null;
        });
        let note = null;
        try {
          const { response, payload } = await fetchJson(
            API_PATH,
            {
              method: "POST",
              headers: { accept: "application/json", "content-type": "application/json" },
              body: JSON.stringify({ action: "redetect" }),
            },
            REDETECT_TIMEOUT_MS,
          );
          if (generation !== this.statusGeneration || this.disposed) return;
          if (!response || response.ok !== true || !isRecord(payload) || payload.ok !== true) note = "unavailable";
        } catch (error) {
          if (generation !== this.statusGeneration || this.disposed) return;
          note = "unavailable";
        }
        if (generation !== this.statusGeneration || this.disposed) return;
        this.store.update((state) => {
          state.redetectNote = note;
        });
        await this.refreshStatus();
      }

      accept(view, writable) {
        const value = isRecord(view.value) ? view.value : {};
        const proxy = typeof value.proxy === "string" ? value.proxy : MODE_AUTO;
        const noProxy = typeof value.noProxy === "string" ? value.noProxy : "";
        const mode = modeOf(proxy);
        const revision = typeof view.revision === "number" && Number.isFinite(view.revision) ? view.revision : 0;
        this.view = view;
        this.store.update((state) => {
          state.settings = "ready";
          state.error = null;
          state.writable = writable === true;
          state.proxy = proxy;
          state.mode = mode;
          state.url = mode === MODE_MANUAL ? proxy : "";
          state.noProxy = noProxy;
          state.revision = revision;
        });
      }

      /** A useful starting point when the user switches to manual mode. */
      suggestManualUrl() {
        const snapshot = this.store.getSnapshot();
        if (snapshot.mode === MODE_MANUAL && snapshot.url !== "") return snapshot.url;
        const value = snapshot.runtime ? snapshot.runtime.value : null;
        if (value && value.upstream && typeof value.upstream.url === "string" && value.upstream.url !== "") {
          return value.upstream.url;
        }
        return "";
      }

      startPolling() {
        if (this.disposed || this.pollTimer !== undefined) return;
        if (typeof window === "undefined" || typeof document === "undefined") return;
        this.pollTimer = window.setInterval(() => {
          if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
          this.maybeRefresh();
        }, POLL_MS);
        if (typeof document.addEventListener === "function") {
          document.addEventListener("visibilitychange", this.onVisibility);
        }
      }

      /** Refresh unless a request (including a re-detect) is already in flight. */
      maybeRefresh() {
        if (this.disposed) return;
        const snapshot = this.store.getSnapshot();
        if (snapshot.runtime && snapshot.runtime.loading === true) return;
        void this.refreshStatus();
      }

      stopPolling() {
        if (this.pollTimer !== undefined && typeof window !== "undefined") {
          window.clearInterval(this.pollTimer);
        }
        this.pollTimer = undefined;
        if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
          document.removeEventListener("visibilitychange", this.onVisibility);
        }
      }

      dispose() {
        this.disposed = true;
        this.settingsGeneration += 1;
        this.statusGeneration += 1;
        this.view = undefined;
        this.stopPolling();
      }
    }

    function ensureStyles() {
      if (typeof document === "undefined") return undefined;
      try {
        if (document.querySelector('style[data-plugin-css="dsh-proxy-failover"]') !== null) return undefined;
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-proxy-failover";
        tag.dataset.pluginCss = "dsh-proxy-failover";
        tag.textContent = styles;
        document.head.appendChild(tag);
        return () => {
          try {
            tag.remove();
          } catch (error) {
            /* the page may already be tearing down */
          }
        };
      } catch (error) {
        /* styling is cosmetic; never block the settings row */
        return undefined;
      }
    }

    function fact(key, label, value, options) {
      const settings = options || {};
      return React.createElement(
        "div",
        { key, className: "dshPfFact", "data-wide": settings.wide === true ? "true" : undefined },
        React.createElement("span", { className: "dshPfFactLabel" }, label),
        React.createElement(
          "span",
          {
            className: "dshPfFactValue",
            "data-mono": settings.mono === true ? "true" : undefined,
            "data-error": settings.error === true ? "true" : undefined,
            title: typeof value === "string" ? value : undefined,
          },
          value,
        ),
      );
    }

    function statusLabel(runtime, t) {
      if (runtime.loading && !runtime.value) return t("checking");
      if (!runtime.value || runtime.available === false) return t("unknown");
      return runtime.value.upstreamUp === true ? t("connected") : t("direct");
    }

    function statusKind(runtime) {
      if (!runtime.value || runtime.available === false) return "idle";
      return runtime.value.upstreamUp === true ? "up" : "direct";
    }

    function ProxyFailoverRow({ controller, useRow, t }) {
      const state = useRow((snapshot) => snapshot);
      const [manualUrl, setManualUrl] = React.useState(state.url);
      const [bypass, setBypass] = React.useState(state.noProxy);
      const [draftManual, setDraftManual] = React.useState(false);

      React.useEffect(() => {
        controller.load();
        controller.startPolling();
        return () => {
          controller.stopPolling();
        };
      }, [controller]);

      React.useEffect(() => {
        setManualUrl(state.url);
      }, [state.url]);

      React.useEffect(() => {
        setBypass(state.noProxy);
      }, [state.noProxy]);

      React.useEffect(() => {
        if (state.settings === "ready" && state.mode === MODE_MANUAL) setDraftManual(false);
      }, [state.settings, state.mode]);

      const busy = state.settings === "loading" || state.settings === "saving";
      const controllable = state.settings === "ready" && state.writable === true;
      const disabledControls = busy || !controllable;
      const manualActive = state.mode === MODE_MANUAL || draftManual;
      const runtime = state.runtime || { loading: true, available: false, value: null, error: null };
      const value = runtime.value || null;
      const manualValue = manualUrl.trim();
      const manualValid = isHttpProxyUrl(manualValue);
      const bypassDirty = bypass.trim() !== state.noProxy;

      const settingsNote = (() => {
        if (state.settings === "unavailable") return { text: t("settingsUnavailable"), error: false };
        if (state.settings === "error") {
          return { text: t("settingsError") + (state.error ? ": " + state.error : ""), error: true };
        }
        if (state.settings === "saving") return { text: t("saving"), error: false };
        if (state.error) return { text: t("saveFailed") + ": " + state.error, error: true };
        if (state.settings === "ready" && !state.writable) return { text: t("readOnly"), error: false };
        return null;
      })();

      const choose = (mode) => {
        if (disabledControls) return;
        if (mode === MODE_MANUAL) {
          if (manualActive) return;
          const suggested = controller.suggestManualUrl();
          setManualUrl(suggested === "" ? manualUrl : suggested);
          setDraftManual(true);
          return;
        }
        if (state.mode === mode) {
          setDraftManual(false);
          return;
        }
        setDraftManual(false);
        void controller.save({ proxy: mode });
      };

      const activeOf = (mode) => {
        if (mode === MODE_MANUAL) return manualActive;
        return draftManual !== true && state.mode === mode;
      };

      const submitManual = (event) => {
        event.preventDefault();
        if (disabledControls || !manualValid) return;
        if (state.mode === MODE_MANUAL && manualValue === state.proxy) return;
        void controller.save({ proxy: manualValue });
      };

      const submitBypass = (event) => {
        event.preventDefault();
        if (disabledControls || !bypassDirty) return;
        void controller.save({ noProxy: bypass.trim() });
      };

      const facts = [];
      facts.push(
        fact("relay", t("relay"), value && value.listen ? value.listen : t("unknown"), {
          mono: true,
        }),
      );
      if (value && value.upstream) {
        facts.push(fact("upstream", t("upstream"), value.upstream.url, { mono: true }));
        facts.push(fact("source", t("source"), value.upstream.source || t("unknown")));
      } else {
        facts.push(fact("upstream", t("upstream"), t("noUpstream")));
        facts.push(fact("source", t("source"), t("unknown")));
      }
      facts.push(fact("fallbacks", t("fallbacks"), String(value ? value.fallbacks : 0)));
      facts.push(fact("requests", t("requests"), String(value ? value.requests : 0)));
      if (value && value.lastError) {
        facts.push(fact("lastError", t("lastError"), value.lastError, { wide: true, error: true }));
      }

      const staleNote = runtime.loading
        ? null
        : runtime.available === false
          ? { text: t("statusUnavailable"), error: false, title: runtime.error || undefined }
          : null;

      return React.createElement(
        "div",
        { className: "dshPfRow" },
        React.createElement(
          "div",
          { className: "dshPfHeader" },
          React.createElement(
            "div",
            { className: "dshPfCopy" },
            React.createElement("div", { className: "dshPfTitle" }, t("title")),
            React.createElement("div", { className: "dshPfDesc" }, t("description")),
            settingsNote
              ? React.createElement(
                  "div",
                  {
                    className: "dshPfNote",
                    "data-error": settingsNote.error === true ? "true" : undefined,
                    role: settingsNote.error ? "alert" : undefined,
                  },
                  settingsNote.text,
                )
              : null,
          ),
          React.createElement(
            "div",
            { className: "dshPfModes", role: "radiogroup", "aria-label": t("title") },
            [MODE_AUTO, MODE_MANUAL, MODE_OFF].map((mode) =>
              React.createElement(
                "button",
                {
                  key: mode,
                  type: "button",
                  role: "radio",
                  "aria-checked": activeOf(mode),
                  "data-active": activeOf(mode) ? "true" : undefined,
                  className: "dshPfMode",
                  disabled: disabledControls,
                  onClick: () => choose(mode),
                },
                t(mode),
              ),
            ),
          ),
        ),
        React.createElement(
          "div",
          { className: "dshPfPanel" },
          React.createElement(
            "div",
            { className: "dshPfPanelHead" },
            React.createElement(
              "span",
              { className: "dshPfState", "data-state": statusKind(runtime) },
              React.createElement("span", { className: "dshPfDot", "aria-hidden": "true" }),
              React.createElement("span", null, statusLabel(runtime, t)),
            ),
            React.createElement(
              "button",
              {
                type: "button",
                className: "dshPfGhost",
                disabled: runtime.loading === true,
                onClick: () => {
                  void controller.redetect();
                },
                title: t("redetect"),
              },
              runtime.loading ? t("checking") : t("redetect"),
            ),
          ),
          React.createElement("div", { className: "dshPfFacts" }, facts),
          staleNote
            ? React.createElement(
                "div",
                { className: "dshPfNote", title: staleNote.title },
                staleNote.text,
              )
            : null,
          state.redetectNote === "unavailable"
            ? React.createElement("div", { className: "dshPfNote" }, t("redetectUnavailable"))
            : null,
        ),
        manualActive
          ? React.createElement(
              "div",
              { className: "dshPfStack" },
              React.createElement(
                "form",
                { className: "dshPfField", onSubmit: submitManual },
                React.createElement("span", { className: "dshPfLabel" }, t("manual")),
                React.createElement("input", {
                  className: "dshPfInput",
                  type: "text",
                  inputMode: "url",
                  value: manualUrl,
                  placeholder: t("manualPlaceholder"),
                  disabled: disabledControls,
                  required: true,
                  autoFocus: draftManual,
                  "aria-label": t("manual"),
                  "aria-invalid": manualUrl !== "" && !manualValid ? "true" : undefined,
                  onChange: (event) => setManualUrl(event.target.value),
                }),
                React.createElement(
                  "button",
                  {
                    className: "dshPfApply",
                    type: "submit",
                    disabled:
                      disabledControls ||
                      !manualValid ||
                      (state.mode === MODE_MANUAL && manualValue === state.proxy),
                  },
                  t("apply"),
                ),
              ),
              manualUrl !== "" && !manualValid
                ? React.createElement("div", { className: "dshPfHint" }, t("manualInvalid"))
                : null,
            )
          : null,
        React.createElement(
          "form",
          { className: "dshPfField", onSubmit: submitBypass },
          React.createElement("span", { className: "dshPfLabel" }, t("bypass")),
          React.createElement("input", {
            className: "dshPfInput",
            type: "text",
            value: bypass,
            placeholder: t("bypassPlaceholder"),
            disabled: disabledControls,
            "aria-label": t("bypass"),
            onChange: (event) => setBypass(event.target.value),
          }),
          React.createElement(
            "button",
            {
              className: "dshPfApply",
              type: "submit",
              disabled: disabledControls || !bypassDirty,
            },
            t("save"),
          ),
        ),
      );
    }

    const inject = ["slots", "locale", "remote", "remote.settings"];

    function apply(ctx) {
      ctx.effect(() => ensureStyles(), "proxy-failover: styles");
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), "proxy-failover: dictionaries");
      const t = ctx.locale.bind(LOCALE_NS);
      const controller = new ProxyFailoverController(ctx.remote);
      const useRow = (selector) =>
        React.useSyncExternalStore(
          (listener) => controller.store.subscribe(listener),
          () => selector(controller.store.getSnapshot()),
          () => selector(controller.store.getSnapshot()),
        );
      const injected = () => ({ controller, useRow, t });

      ctx.effect(
        () => {
          const refresh = () => {
            if (controller.store.getSnapshot().settings !== "idle") controller.load();
          };
          const disposers = [];
          try {
            if (ctx.remote !== null && typeof ctx.remote === "object" && typeof ctx.remote.$on === "function") {
              disposers.push(
                ctx.remote.$on("settings/document-updated", (ns) => {
                  if (ns === SETTINGS_NS) refresh();
                }),
              );
            }
          } catch (error) {
            /* invalidation is an optimization; the 5s poll still converges */
          }
          try {
            disposers.push(ctx.on("connection/reset", refresh));
          } catch (error) {
            /* connection events may be unavailable on older shells */
          }
          return () => {
            controller.dispose();
            for (const dispose of disposers) {
              try {
                dispose();
              } catch (error) {
                /* already disposed */
              }
            }
          };
        },
        "proxy-failover: invalidations",
      );

      ctx.effect(
        () => {
          const dispose = ctx.slots.inject("settings.general.item", () =>
            ctx.slots.register(
              {
                name: "settings.general.item",
                id: "proxy-failover",
                order: 21,
                locale: LOCALE_NS,
                inject: injected,
              },
              ProxyFailoverRow,
            ),
          );
          return typeof dispose === "function" ? dispose : undefined;
        },
        "proxy-failover: settings row",
      );
    }

    module.exports.apply = apply;
    module.exports.inject = inject;
    return module.exports;
  },
});
