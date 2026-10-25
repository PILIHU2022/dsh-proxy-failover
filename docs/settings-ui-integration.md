# Settings UI integration (client half)

This plugin now ships a client-side settings row for **Settings → General**:

- Title: `代理容错出网` / `Failover Egress`
- Shows the live relay address, upstream URL + source, connected/direct state,
  request/fallback counts, and `lastError` when present.
- Edits `proxy` (auto / off / manual URL) and `noProxy` through the
  `proxy-failover` Remote settings namespace.
- Re-detects through `POST /proxy-failover/api` with `{ "action": "redetect" }`.
- Polls `GET /proxy-failover/status` every 5 s while the row is mounted and
  the document is visible.

`lib/client.js` is the only runtime file added. The host half is untouched.
`package.json`, `cordis.patch.yml`, `locale/*.json`, and the existing host
`lib/*.js` files were intentionally **not** edited.

---

## 1. `package.json` changes (already applied)

The host package now declares:

```json
"exports": {
  ".": "./lib/index.js",
  "./client": "./lib/client.js",
  "./locale/*.json": "./locale/*.json",
  "./icon": "./icon.svg",
  "./package.json": "./package.json"
},
"dsh": {
  "category": "extension",
  "displayName": "代理容错出网",
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "inject": [
      "@deepseek-ai/dsh-client-store",
      "@deepseek-ai/dsh-client-connection",
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-settings"
    ],
    "platform": "web"
  }
}
```

`lib/client.js` is covered by the existing `"lib"` entry in `files`. The client
inject ids mirror `dsh-web-fetch-proxy/lib/client.js`; `react` and `ctx.slots`
come from the Web shell and are not declared.

## 2. How the client is served

No build step is required. `lib/client.js` is a plain client bundle in the
`window.__ModuleLoader__.load({ id, factory })` format.

1. `@deepseek-ai/dsh-client-modules` scans the active Loader entries for
   packages whose manifest declares `dsh.client` with `platform: "web"`.
2. It resolves `exports["./client"]` (string or `{ "default": ... }`) and reads
   the file as-is.
3. It composes the browser module graph (`window.__DSH_BOOT__`), serves the
   bundles through the Web plugin routes (`/plugins/...`), and injects the
   graph into the page.
4. The browser executes the file, which only registers the factory. The
   factory materializes when the graph imports `dsh-proxy-failover`, and
   `apply(ctx)` registers styles, dictionaries, invalidation listeners and the
   `settings.general.item` row.
5. The `dsh.client.inject` rows are loaded before this factory, so the store,
   connection/remote, locale and settings modules are registered first.

The module id in `lib/client.js` **must** remain the package name
(`dsh-proxy-failover`).

Because the profile installs this package with
`link:/home/Projects/dsh-plugins/dsh-proxy-failover`, a manifest change is picked
up after a profile/Loader restart (or a bundle rebuild plus page refresh).
Editing `lib/client.js` itself is served from the linked path on the next page
load. The client module scanner caches negative “not a client package” verdicts
per Loader specifier until restart, so the first integration **does** require a
`dsh web` restart, not just a browser refresh.

## 3. Host contract (implemented)

### Settings namespace

The host does **not** call `settings.register` (that method does not exist in
`@deepseek-ai/dsh-settings@0.2.1-rc.3`). Instead `lib/index.js` exports a
schemastery `Config`:

```js
export const Config = z.object({
  proxy: z.string().default("auto").volatile(),
  noProxy: z.string().default("").volatile(),
  // ordinary deploy-only fields: listenPort, probeIntervalMs, timeouts, ...
});
```

- `SettingsForms.describe()` reads `entry.fiber.runtime.Config`, keeps only the
  volatile fields, and uses the Loader entry id as the namespace key. The row id
  is `proxy-failover`, so the client's `SETTINGS_NS` matches.
- `applies: "live"` is automatic for volatile fields. The Loader updates the
  resolved config refs in place (`config.proxy.get()`), without remounting the
  plugin.
- `lib/index.js` listens for `loader/volatile-update` and calls
  `manager.configure({ proxy, noProxy })`; `normalizeConfig()` unwraps both
  plain values and `{ get() }` refs. The relay's upstream/bypass therefore update
  in place: no new relay port, no dispatcher reinstall, no interrupted stream.

The client reads and writes through the standard Remote settings RPC:

```js
const view = (await ctx.remote.settings.describe()).value.namespaces
  .find((entry) => entry.ns === "proxy-failover");
await ctx.remote.settings.mutate(
  "proxy-failover",
  [{ op: "set", path: ["proxy"], value: "off" }],
  view.revision,
);
```

If the namespace is missing (older DSH or schemastery unresolved), the panel
degrades to status-only and disables saving; it never throws.

### Status and action endpoints

- `GET /proxy-failover/status` — `{ ok: true, value: { relay, proxy, ... } }`
  (loopback host only, same-origin, GET only).
- `POST /proxy-failover/api` — `{ "action": "status" | "redetect" | "configure" }`.
  `redetect` re-scans candidates; `configure` applies an explicit
  `{ proxy, noProxy }` in place and returns the new snapshot. The body is capped
  at 64 KiB.
- The client tolerates 403/404/405, non-JSON bodies, timeouts and network errors.

## 4. Verification

```bash
cd /home/Projects/dsh-plugins/dsh-proxy-failover
node --check lib/client.js
```

The host routes and the settings namespace are live now. The client bundle needs
one DSH restart (the Web client scanner caches the earlier "not a client package"
verdict for this linked package). After that restart:

1. Open **Settings → General**; the `代理容错出网` row should appear after the
   Web Fetch proxy row (order 21).
2. Confirm `GET http://127.0.0.1:<web-port>/proxy-failover/status` returns the
   envelope.
3. Switch to `关闭`, then `自动检测`; each save should update the host config
   without a restart.
4. Type a manual URL (`http://127.0.0.1:7890`) and press `应用`.
5. Press `重新检测`; if `/proxy-failover/api` is not implemented yet, the row
   shows the “re-detect endpoint unavailable” note and still refreshes status.
6. Resize below 680 px: the mode group and fields stack vertically.

If the row does not appear:

- Check the browser console for `client-modules` composition errors and confirm
  `dsh-proxy-failover` is in the boot graph.
- Confirm `exports["./client"]` resolves and `dsh.client.platform === "web"`.
- Confirm the settings namespace appears in `ctx.remote.settings.describe()`
  (otherwise the row renders status-only with a settings-unavailable note).
- Remember the negative package-metadata cache: restart the Web process after
  the first manifest change.

## 5. Assumptions and risks

- **`settings.general.item` is the right slot in this DSH version.** Verified
  against the installed DSH 0.2.1-rc.3: `@deepseek-ai/dsh-client-ui-settings-general`
  renders `settings.general.item`, and the slot type is declared in
  `@deepseek-ai/dsh-client-ui-settings`. It is an additive settings row, not a
  standalone page. If a future DSH removes that slot, the registration fails
  silently from the user's point of view; the fix is to move to
  `settings.section` (a full page) or the replacement slot.
- **Namespace key equals the Loader entry id.** The client hard-codes
  `SETTINGS_NS = "proxy-failover"`. If the host registers the namespace under a
  different entry id, change that constant (and nothing else).
- **Revision writes.** The client follows the reference `describe` →
  `mutate(revision)` flow. A conflict is surfaced as a save error; the next
  successful `describe` refresh (for example from `settings/document-updated`)
  restores the current revision.
- **Settings API version drift.** The installed `@deepseek-ai/dsh-settings@0.2.1-rc.3`
  exposes `describe/update/replace/mutate/configure` but **not** the older
  `register`/`watch`/`scope` API. Host code copied from
  `dsh-web-fetch-proxy` will fail at runtime and leave the namespace absent.
  Use the exported volatile `Config` route, and unwrap `config.proxy.get()`
  because the Loader passes schemastery accessor refs (not plain strings) to
  `apply`. Live writes mutate those refs in place, so listen for
  `loader/volatile-update` (the event the current host half uses) or
  `settings/document-updated`, and read the refs again.
- **`lastError` is untrusted display text.** It is rendered as text content
  (never HTML), wrapped and allowed to ellipsize/wrap in the error fact.
- **Status is advisory.** A failed status request keeps the last known value,
  changes the state dot to idle/unknown, and shows a localized “unreachable”
  note; it never blocks saving settings.
- **Visibility.** Polling is paused while `document.visibilityState` is
  `hidden`; it resumes on the next visible interval or `visibilitychange`.
  Rendering the General section while the dialog is closed would keep the
  5-second poll active, which is harmless but could be optimized with an
  `IntersectionObserver`.
- **Same-origin / loopback.** Both requests use
  `credentials: "same-origin"`. The host routes are loopback/trusted-host
  restricted; when the UI is opened through a non-trusted host, status shows
  unreachable and saves still work through the Remote settings RPC.
- **No locale JSON changes.** All zh/en strings live inside `lib/client.js`
  under `settings.proxyFailover`; the existing `locale/zh.json` and
  `locale/en.json` are untouched.
- **Unverified in a live browser.** The file passes `node --check`, and a
  stubbed render harness exercised the ready/unavailable/manual/error states,
  but the final visual result and `ctx.slots`/`ctx.remote` wiring need a real
  DSH page after the package.json integration.
