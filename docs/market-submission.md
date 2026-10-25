# Market submission — dsh-proxy-failover

Current state of this plugin's DSH market listing: what exists, what was submitted, and what is
still open. Written on 2026-10-25 against the tooling here (dshmarket 1.70.2) and the
`awesome-dsh-plugin` contributing rules.

- Target entry: [`market-entry.json`](./market-entry.json)
- Listing copy: [中文](./market-listing.zh.md) · [English](./market-listing.en.md)

## 1. State at a glance

| Item | State |
| --- | --- |
| Repository | published — https://github.com/PILIHU2022/dsh-proxy-failover (created 2026-10-25T02:47:46Z, public, `main`) |
| License | MIT, `Copyright (c) 2026 PILIHU2022` |
| Bundle manifest | `package.json` declares `dsh.bundle.patch` → `./cordis.patch.yml`, plus `engines.dsh` and optional `peerDependencies` |
| Package metadata | `repository`, `homepage`, `bugs`, `author` point at the public repo; name/version `dsh-proxy-failover` 0.1.0 |
| Docs | bilingual `README.md` / `README.en.md`; listings in `docs/market-listing.{zh,en}.md` |
| Icon | `assets/icon-180.png`, a real 180×180 RGBA PNG, is the catalog tile; `icon.svg` stays for DSH's own UI |
| Catalog entry | `data/plugins/PILIHU2022__dsh-proxy-failover.yml`, category `browser`; opened as [PR #9255](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/9255) — **pending, not merged** |
| Expected pending check | repo age ≥ 1 day: red until 2026-10-26T02:47:46Z, then CI re-runs it on its own |
| npm / tarball | npm not published (optional; no credentials here), no GitHub Release asset |
| Format-1 index | `market-entry.json` points its version source at the pushed git commit `27c2292` (shape-validated with `parseMarketIndex`); serving it is still optional |

No CI result is recorded here; the expected pending state is "only the age gate is red".

## 2. Two registries, two shapes

| | awesome-dsh-plugin catalog (what dshmarket shows) | DSH native market index (Discover) |
| --- | --- | --- |
| Format | one YAML per plugin, `data/plugins/<owner>__<repo>.yml` | one format-1 JSON document (`{format: 1, title, metadata, plugins}`) |
| Lives in | PR against `awesome-dsh-plugin/awesome-dsh-plugin` | any index URL a user adds under Plugins → Discover |
| Served as | `https://awesome-dsh-plugin.com/plugins.json` | a self-hosted `index.json`, for example |
| Install string | generated: npm > tarball > `github:owner/repo` | generated per version: `name@version` (npm) or `git+<url>#<commit>` |

The catalog PR is the listing step; the format-1 index only matters if the plugin is also offered through a Discover index source.

## 3. The catalog entry

Submitted file: `data/plugins/PILIHU2022__dsh-proxy-failover.yml`.

```yaml
url: https://github.com/PILIHU2022/dsh-proxy-failover
name: PILIHU2022/dsh-proxy-failover
category: browser
description:
  en: "Loopback relay as DSH's process-wide proxy route: web_fetch works under TUN fake-ip; a dead proxy gets same-request direct fallback, and a probe switches back."
  zh: "把回环 HTTP 中继设为 DSH 的进程级代理路由，让 web_fetch 在 Mihomo/Clash TUN fake-ip 下正常出网；上游代理不可用时，同一请求内改走直连，1.5 秒探活发现代理恢复后自动切回。"
icon: https://raw.githubusercontent.com/PILIHU2022/dsh-proxy-failover/main/assets/icon-180.png
```

Rules that apply:

- The filename must equal the slug of `url`: `<owner>__<repo>.yml` (`<owner>__<repo>--<subpath>.yml`
  for a monorepo subpackage).
- Only `url`, `name`, `category`, `description`, `icon`, `tarball` are allowed; a hand-written
  `npm:`, `version:`, or `screenshots:` key is rejected.
- `category` must be one of the catalog's 23 ids. `browser` is the submitted choice because that is
  where web_fetch entries already sit (e.g. `kaminn__dsh-web-fetch-fakeip.yml`); `tools` and `dev`
  were the alternates, and a maintainer re-files rather than bouncing a near miss.
- `icon` must be https, GitHub-hosted, and raster (`png`/`jpg`/`jpeg`/`webp`); `assets/icon-180.png`
  is 180×180, so it qualifies. No `tarball:` line — there is no GitHub Release asset.
- `description.en` is required, one line, single-quoted (hence the doubled apostrophe in `DSH''s`).

## 4. CI checks and the age gate

In order: entry count → `dsh.bundle` fetched from `package.json` → repository age → formatting and
site build. Two deserve planning around:

- **Repository age ≥ 1 day.** The repository was created 2026-10-25T02:47:46Z, so the check cannot
  pass before 2026-10-26T02:47:46Z. It is a scheduled re-check: extra commits, closing and reopening
  the PR, or resubmitting do not speed it up.
- **`dsh.bundle` presence.** The checker reads `package.json` from the pushed default branch, so it
  passes once the initial push carrying this tree lands.

The PR is expected to sit pending until the age gate clears, then go green without intervention.

## 5. What users install

With no npm package and no release asset, the catalog generates the GitHub source:

```bash
dsh plugin --profile web add github:PILIHU2022/dsh-proxy-failover
```

That builds from the repository, so it relies on the `dsh.bundle` patch (present) and the declared
engines. A local checkout works too:
`dsh plugin --profile web add link:/home/Projects/dsh-plugins/dsh-proxy-failover`.

## 6. npm publish (optional)

Not required: an entry without an npm package works the same, minus the download figure. Publishing
would additionally show a download count, let the format-1 index use `{"type": "npm"}` instead of a
commit SHA, and remove the build-from-source step.

`package.json` already carries `repository` / `homepage` / `bugs`, which is what links a published
package back to the catalog entry. Nothing here can publish — that needs an npm token (or a local
`npm login`) from the maintainer. If it happens, switch the version source and `publishTimestamp`
in [`market-entry.json`](./market-entry.json) to npm.

## 7. Format-1 index (optional)

`market-entry.json` holds a format-1 plugin object under
`registryEntries.dshMarketIndexFormat1`. Its version source is `git`, because there is no npm
release: `MarketSource` is either `{type: "npm"}` or `{type: "git", url, commit, path?}`, and
`commit` is the lowercase 40-hex SHA of the pushed commit
`27c22920c64de328990b302ffbd4ec09d275c154`. `parseMarketIndex` accepts this object; wrap it
in an index document to serve it:

```bash
node --input-type=module -e '
import fs from "node:fs";
import { parseMarketIndex } from "@deepseek-ai/dsh-plugin-market-index";
const entry = JSON.parse(fs.readFileSync("docs/market-entry.json", "utf8")).registryEntries.dshMarketIndexFormat1;
const doc = { format: 1, title: { en: "dsh-proxy-failover" }, metadata: { categories: { browser: { title: { en: "Browser & Fetching" } } } }, plugins: [entry] };
console.log(parseMarketIndex(doc, "https://awesome-dsh-plugin.com/index.json").plugins.length);
'
```

## 8. Verify locally

```bash
cd /home/Projects/dsh-plugins/dsh-proxy-failover
node --test test/*.test.mjs
node scripts/verify.mjs

dsh plugin --profile web add link:/home/Projects/dsh-plugins/dsh-proxy-failover
curl -s http://127.0.0.1:3080/proxy-failover/status | jq '.value | {installed, routed, relay: .relay.upstreamUp}'
```

Expected: `installed: true`, `routed: true`, and `upstreamUp` reflecting whether Clash/Mihomo is
running. With the proxy closed, `fallbacks` increments while web_fetch and model calls keep working.
Keep `dsh-web-fetch-proxy` disabled — both plugins install a process-wide route.

## 9. Still open

- [x] Fill `versions[0].source.commit` and `publishTimestamp` in `market-entry.json` after the push.
  The format-1 object now validates with `parseMarketIndex` against commit
  `27c22920c64de328990b302ffbd4ec09d275c154`.
- [ ] Wait out the age gate (2026-10-26T02:47:46Z); the PR stays pending until then and is not merged.
- [ ] After merge, replace `homepage` with `https://awesome-dsh-plugin.com/p/PILIHU2022/dsh-proxy-failover/`.
- [ ] Optional: npm publish, a release tarball, or 1-8 screenshots plus `screenshots.json`.
