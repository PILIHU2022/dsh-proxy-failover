# dsh-proxy-failover

> DSH 插件：`web_fetch` 经本地代理（Mihomo / Clash 等）出网以绕过 TUN fake-ip；
> 代理关闭后，同一请求自动改走直连，模型不再对失效代理反复重试。
>
> English: [README.en.md](./README.en.md)

## 症状

开着 Mihomo/Clash 的 TUN + fake-ip 打开 DSH 后，`web_fetch` 报：

```
URL hostname "raw.githubusercontent.com" resolves to a non-public IP address
```

用 [dsh-web-fetch-proxy](https://github.com/1499501762/dsh-web-fetch-proxy) 一类插件把
`web_fetch` 接到本地代理后，抓取恢复了；但只要**关掉代理**（DSH 配置没动、也没重启），
模型请求就会卡在重试里，最后整轮任务中断。

## 根因

两件事叠在一起：

1. **fake-ip**：TUN 模式下 DNS 对任何域名都返回合成地址（如 `198.18.0.22`、
   `fdfe:dcba:9876::ed`）。`web_fetch` 会先本地解析、再逐条校验地址是否公网，
   任一条不合格就整体拒绝，连接根本没有发出去。
2. **进程级代理路由比代理进程活得久**：`@deepseek-ai/dsh-http-proxy` 把一条
   **进程级** 代理策略装进 undici 的全局 dispatcher。`web_fetch` 正是靠
   `proxyRouteFor()` 看到「已代理」才跳过本地 DNS 校验。
   现有插件（如 [dsh-web-fetch-proxy](https://github.com/1499501762/dsh-web-fetch-proxy)）
   把真实代理地址（如 `http://127.0.0.1:7890`）直接装了进来；
   代理关掉后这条路由仍在，之后**所有**出站请求（包括模型 API）继续拨一个已经不存在的端口，
   连接被拒 → `dsh-llm-retry` 退避重试 → 仍然失败 → 回合中断。

换句话说：`web_fetch` 需要的「代理路由」，和模型需要的「代理关闭后能直连」，是同一个全局开关。
把真实代理写死进去，就只能在两者之间二选一。

## 为什么还要写这个新插件

[dsh-web-fetch-proxy](https://github.com/1499501762/dsh-web-fetch-proxy) 已经解决了 fake-ip
这一半问题：它把本地代理（如 `http://127.0.0.1:7897`）装成
`@deepseek-ai/dsh-http-proxy` 的进程级策略，`web_fetch` 因此看到 `proxied` 路由、跳过本地
DNS 校验，抓取恢复正常。这个思路本插件照旧沿用。

剩下的问题是这条路由的**生命周期**：策略属于 DSH 进程，而不是属于代理进程。一经安装，它就与
DSH 进程同寿；代理关闭后，路由仍然指向那个已经没人监听的端口。此后所有出站请求——包括模型
API，以及 `dsh-llm-retry` 的重试——都会拨这个死端口，拿到 `ECONNREFUSED`，退避后再试，仍然
失败，直到当前回合中断；只有重启 DSH 或让插件重新探测到代理，才会恢复。

本插件补的正是这一段：

- 装进进程级路由的是**回环 relay**，它随 DSH 启动、始终在线，不会随代理进程消失；
- 每个请求独立判断：上游可达就隧道到代理，不可达就在**同一个请求内**改直连并记下上游故障；
- 后台探活（默认 1500 ms）发现代理恢复后自动切回，代理比 DSH 晚启动也能自己接管；
- 代理失联时主动关闭经它的旧隧道，避免客户端连接池继续复用死连接；
- 直连 DNS 用 OS 解析器与 c-ares 并行，TUN 刚关闭、系统解析卡住时也不会拖满
  `resolveTimeoutMs`。

因此本插件在功能上是它的超集：既保留 fake-ip 修复，也补上代理关闭后的同请求直连与自动切回。
两个插件都会安装进程级路由，**不要同时启用**（原因见下方「和 dsh-web-fetch-proxy 的关系」）。

## 这个插件怎么做

插件不再把真实代理装成全局路由，而是先在本机起一个**只监听回环地址的小型 HTTP 代理（relay）**，
把 relay 作为进程级路由。relay 在**每次请求时**决定怎么走：

```
                 ┌──────────────────────────────┐
  模型 API ──────┤                              ├── 上游代理（Mihomo :7890）→ 网络
  web_fetch ─────┤   relay 127.0.0.1:<随机端口>  │
  MCP / 搜索 ────┤                              ├── 直连（上游不可用时，同一请求内切换）
                 └──────────────────────────────┘
```

- 上游代理可用：隧道/转发到真实代理。`web_fetch` 依然拿到 `proxied` 路由，
  由代理侧解析域名，**fake-ip 问题照旧被绕过**。
- 上游代理已关闭：relay 拨号失败后**立刻在同一个请求里**直连，新请求不需要重试；
  同时把上游标记为 down，后续请求不再徒劳去拨它。
- 代理重新打开：后台探活（默认 1.5 秒）发现端口恢复，自动切回代理路径。
- 代理比 DSH 晚启动：同样由后台探活自动接管，不需要重启 DSH。
- 代理关闭的瞬间：relay 检测到上游 socket 断开/探活失败后，会主动关闭经该代理的旧隧道，
  让客户端的连接池立即丢弃死连接，下一次请求直接走直连，不会复用一条已经断掉的隧道。

因为客户端连接的是「永远在线」的 relay，代理的生死只会影响 relay 到上游那一段：
路由本身不会失效，**新的**模型请求和 `web_fetch` 请求会由 relay 直接改走直连，
既不会反复重试死端口，也不会因为路由还指着一个没人的端口而卡住。
只有「代理断掉的那一刻已经在传输中」的请求会断一次，这是传输层事实，见下一节。

### 为什么有时仍会看到一次重试，以及如何做到 0 次

- **正在流式返回的请求**在代理被关闭的那一刻必然断一次：字节流已经走在代理上，
  任何进程都无法把这条 TLS 流迁移到直连。`dsh-llm-retry` 会立即重跑这一步。
- 旧版本里，重跑时系统 DNS 还没从 TUN 的 fake-ip 状态恢复，`dns.lookup()` 会卡满
  `resolveTimeoutMs`（5 秒）后才失败，于是出现第二次失败。现在 **OS 解析与 c-ares
  并行**，c-ares 使用系统 DNS 服务器直接发新查询，通常在毫秒级返回，所以第一次重跑
  就能成功（`relay.dns.lastSource = "cares"` 可以看到）。
- 如果希望**连这一次重跑也没有**，把模型 API 的主机名加入 `noProxy`
  （例如 `api.deepseek.com`）。这些主机的流量会直接走 relay 的直连分支，不再经过
  本地代理，代理关闭对它们没有任何影响。设置页里可以直接改 `noProxy`。

## 安装

### 本地目录（开发）

```bash
dsh plugin --profile web add link:/path/to/dsh-proxy-failover
```

### 从 GitHub 安装

仓库已公开：<https://github.com/PILIHU2022/dsh-proxy-failover>。
npm 尚未发布，所以除本地目录外只有 GitHub 源可用：

```bash
dsh plugin --profile web add github:PILIHU2022/dsh-proxy-failover
```

也可以让插件管理器的 `install_bundle` 指向本地目录。安装后 bundle patch 会插入一行：

```yaml
- insert:
    - id: proxy-failover
      name: dsh-proxy-failover
      config:
        proxy: auto
```

更新插件代码后，重新启用该行（或重启 DSH）即可加载新代码。

### 和 [dsh-web-fetch-proxy](https://github.com/1499501762/dsh-web-fetch-proxy) 的关系

**不要同时启用两个插件。** 两者都会安装进程级路由，语义会互相覆盖：

- 本插件先装：对方 `reconcile` 时看到已有 proxied 路由，会直接让路，通常不会打架；
- 对方先装：本插件会接管并保存上一条路由，禁用本插件时会还原——但还原出来的仍是
  对方那条「指向真实代理」的路由，代理关掉后又会复发。

推荐保留本插件、禁用 `dsh-web-fetch-proxy`（如果已经安装）。
本插件在功能上是它的超集：既修 fake-ip，也修代理关闭后的模型重试。

## 配置

`cordis.patch.yml` 的 `config`（部署级）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时完全不介入，保持宿主原有路由 |
| `proxy` | `auto` | `auto` 自动发现；`off`/`none`/`direct` 强制直连；也可写死 `http://127.0.0.1:7890` |
| `noProxy` | `""` | 追加到 `no_proxy`，逗号分隔；回环地址始终绕过 |
| `probeIntervalMs` | `1500` | 上游探活 / 重新发现间隔（默认 1.5 秒） |
| `probeTimeoutMs` | `400` | 单个候选端口 TCP 探测超时 |
| `connectTimeoutMs` | `10000` | relay 连接上游 / 目标的超时 |
| `handshakeTimeoutMs` | `10000` | 上游 CONNECT 握手超时 |
| `resolveTimeoutMs` | `5000` | 直连路径的 DNS 总超时（OS 与 c-ares 并行，先到先用） |
| `listenPort` | `0` | relay 端口；`0` 表示随机端口，仅监听 `127.0.0.1` |
| `candidatePorts` | 常见代理端口 | `7890, 7897, 7891, 7899, 10809, 10808, 1080, 2080, 20171, 8889` |

`proxy: auto` 的发现顺序：显式配置 → `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`
（大小写都读）→ Clash/Mihomo/Clash Verge 配置里的 `mixed-port` → 常见端口。
环境变量和 Clash 配置视为可信；端口探测出来的候选会额外做一次 `CONNECT` 握手，
避免把恰好占用 7890 的普通服务误当成代理。

## 设置页面

`代理容错出网` 会出现在 **设置 → 常规**（`settings.general.item`），提供：

- 实时状态：relay 地址、上游代理与来源、已连接/已直连、请求数、故障切换数、`lastError`；
- 模式：自动检测 / 关闭 / 手动代理 URL；
- `noProxy` 绕过列表；
- `重新检测` 按钮。

保存走 `proxy-failover` 设置命名空间（两个字段都是 `volatile`，由 Loader 原地更新，
不会重启插件或更换 relay 端口）。宿主侧另有：

```bash
# 读取状态
curl -s http://127.0.0.1:3080/proxy-failover/status | jq
# 重新探测上游
curl -s -X POST -H 'content-type: application/json' \
  --data '{"action":"redetect"}' http://127.0.0.1:3080/proxy-failover/api
# 立即应用配置（不持久化；持久化请用设置页）
curl -s -X POST -H 'content-type: application/json' \
  --data '{"action":"configure","config":{"proxy":"auto","noProxy":""}}' \
  http://127.0.0.1:3080/proxy-failover/api
```

> **首次加入设置页需要重启一次 DSH。** 当前进程已经加载了旧的客户端模块清单，
> Web 客户端的包扫描带有“非客户端包”负缓存；重启后 `lib/client.js` 才会进入
> boot graph。宿主端的状态接口和设置命名空间已经生效，不依赖重启。

## 状态与排障

只读状态接口（仅回环地址可访问，GET）：

```bash
curl -s http://127.0.0.1:3080/proxy-failover/status | jq
```

```json
{
  "ok": true,
  "value": {
    "installed": true,
    "plugin": "dsh-proxy-failover",
    "routed": true,
    "relay": {
      "listen": "http://127.0.0.1:43957",
      "requests": 42,
      "fallbacks": 1,
      "upstream": { "url": "http://127.0.0.1:7890", "source": "port-probe:7890" },
      "upstreamUp": false,
      "lastError": "连接上游失败: connect ECONNREFUSED 127.0.0.1:7890",
      "tunnels": { "active": 2, "closedOnProxyLoss": 3 },
      "dns": { "fallbacks": 1, "failures": 0, "lastMs": 0, "lastSource": "cares" }
    }
  }
}
```

- `routed: true`：`proxyRouteFor()` 确实指向本 relay，`web_fetch` 会跳过本地 DNS 校验；
- `upstreamUp: false` + `fallbacks > 0`：代理已经关闭，最近的请求走了直连；
- `requests` 包含模型 API、`web_fetch`、MCP 等所有经全局 dispatcher 的请求；
- `tunnels.closedOnProxyLoss`：代理失联时主动关闭的旧隧道数；
- `dns.lastSource = "cares"`：这次直连是 c-ares 先返回的（说明系统解析正好卡住，备用解析救了场）。

日志里能看到的状态迁移：

```
[proxy-failover] 上游代理已启用：http://127.0.0.1:7890（来源：port-probe:7890）
[proxy-failover] 上游代理 http://127.0.0.1:7890 不可用，后续请求自动直连：连接上游失败: connect ECONNREFUSED ...
[proxy-failover] 上游代理已启用：http://127.0.0.1:7890（来源：port-probe:7890）
```

## 安全性

- relay **只监听 `127.0.0.1`**，且拒绝把 `CONNECT`/请求转发到回环、链路本地
  （含 `169.254.169.254` 云元数据）、组播、6to4、NAT64 等地址；
- 允许 RFC1918 / CGNAT / ULA 直连：全局路由会影响局域网内的模型端点与 MCP 服务，
  这与真实代理的直连行为一致。需要更严格时可在 `noProxy` 或代理规则里限制；
- `web_fetch` 的 SSRF 校验在「已代理」时本来就会被跳过，本插件沿用这一语义；
  上游代理可用时由代理决定去向，上游不可用时由 relay 做上述地址过滤；
- fail-open：模块求值、`apply()`、探活、状态接口全部包在 try/catch 里；
  安装失败会回滚 dispatcher 与环境变量，绝不把原本可用的网络改坏；
- 状态接口只接受回环 Host、同源 GET，跨站请求与写操作一律拒绝（写配置走已鉴权的设置 RPC）。

## 验证

```bash
cd /home/Projects/dsh-plugins/dsh-proxy-failover
node --test test/*.test.mjs   # 28 个单元 / 集成测试
node scripts/verify.mjs       # 真实网络：代理路径 + 死代理直连回退 + OS DNS 卡死时的 c-ares 兜底
```

测试覆盖：地址过滤、代理发现、CONNECT 验证、上游转发、上游拒绝不降级、
同一请求内故障回退、代理失联时关闭旧隧道、relay 关闭后已建立隧道仍可读写、
OS 解析卡死时 c-ares 兜底、全局 dispatcher 安装/还原、原地重配置不换 relay/端口、
代理恢复后的重新接管。

## 已知限制

- 只支持 `http(s)://` 代理，不支持 SOCKS / PAC（与 `@deepseek-ai/dsh-http-proxy` 一致）；
- 上游代理认证只支持 URL 里的 Basic 凭据；
- 代理若在**响应传输中途**被杀，已经建立的隧道仍会断开——这是传输层事实，
  插件保证的是「下一次请求」不需要重试，而不是让断掉的字节流复活；
- 端口探测依赖 `CONNECT example.com:443` 验证；完全离线时可能找不到代理，
  此时退回直连（离线状态下本来也无法出网）；
- 设置页的客户端 bundle 在加入后的**首次 DSH 重启**后才会出现；宿主接口不受影响；
- `noProxy` 的运行时改动由 relay 直接分流（功能等同），但全局策略里的 `no_proxy`
  仍是启动时的值，直到下一次插件重载才更新；对子进程也无影响；
- `web_fetch` 的 fake-ip 修复依赖 `@deepseek-ai/dsh-http-proxy` 的实例身份；
  插件会通过 `DSH_HOME`、安装目录、`cwd` 等锚点解析，并在安装后自检 `routed`。

## 插件市场

- 仓库（公开）：[PILIHU2022/dsh-proxy-failover](https://github.com/PILIHU2022/dsh-proxy-failover)
- 许可：[MIT](./LICENSE)
- README：中文 [README.md](./README.md) / English [README.en.md](./README.en.md)
- 图标：[`assets/icon-180.png`](./assets/icon-180.png)（raster PNG；catalog 不接受 SVG 图标）
- 上架材料：[`docs/market-listing.zh.md`](./docs/market-listing.zh.md) /
  [`docs/market-listing.en.md`](./docs/market-listing.en.md)、
  [`docs/market-entry.json`](./docs/market-entry.json)、
  [`docs/market-submission.md`](./docs/market-submission.md)

目录条目是 `awesome-dsh-plugin/awesome-dsh-plugin` 仓库里的
`data/plugins/PILIHU2022__dsh-proxy-failover.yml`，对应的 PR 正在提交。该 catalog 要求
仓库创建满 1 天，所以 PR 的 CI 可能持续 pending 约 24 小时；**目前尚未合并，也还没有
出现在 awesome-dsh-plugin 列表中**，请以 PR 状态为准。

## License

[MIT](./LICENSE)
