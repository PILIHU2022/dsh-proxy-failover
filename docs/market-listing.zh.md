# 代理容错出网（dsh-proxy-failover）

> **一句话简介（≤120 字）：** web_fetch 在 Mihomo/Clash TUN + fake-ip 下经本地代理出网；代理关闭后同一请求自动改走直连，模型不再重试失效端口。

| 项目 | 内容 |
| --- | --- |
| 包名 | `dsh-proxy-failover` |
| 版本 | 0.1.0 |
| 分类 | `browser`（浏览器与抓取，web_fetch 类条目所在的分类）；备选 `tools`、`dev` |
| 标签 | `web-fetch` `proxy` `clash` `mihomo` `fake-ip` `tun` `failover` `loopback-relay` `network` |
| 兼容性 | DSH `>=0.2.0-rc.2` 或 `>=0.2.1-rc.2`；Node `^22.19.0` 或 `>=24`；Linux / Windows / macOS |
| 许可证 | MIT |
| 仓库 | `https://github.com/PILIHU2022/dsh-proxy-failover` |
| 市场页 | 尚未生成：目录条目 PR 待合并；合并后为 `https://awesome-dsh-plugin.com/p/PILIHU2022/dsh-proxy-failover/` |
| 入口 | bundle patch 插入行 id `proxy-failover`，包名 `dsh-proxy-failover` |

## 症状

开着 Mihomo / Clash 的 TUN 模式与 fake-ip 使用 DSH 时，内置 `web_fetch` 直接失败：

```text
URL hostname "raw.githubusercontent.com" resolves to a non-public IP address
```

常见的绕法是装 [`dsh-web-fetch-proxy`](https://github.com/1499501762/dsh-web-fetch-proxy) 一类插件，把 `web_fetch` 接到真实的本地代理（如 `http://127.0.0.1:7890`）。抓取确实恢复了，但**只要关掉代理**——DSH 配置没动、进程也没重启——模型请求就会卡在重试里，最后整轮任务中断。

## 为什么还要这个插件

[`dsh-web-fetch-proxy`](https://github.com/1499501762/dsh-web-fetch-proxy) 只修 fake-ip：它把 `web_fetch` 指向真实本地代理，但那条进程级路由在代理关掉后仍然指着失效端口。本插件是它的超集，多出来的部分是：

- 只监听回环地址的 relay 作为全局路由，真实代理的生死不再直接决定请求成败；
- 代理关闭时在**同一请求内**改走直连，直连路径的 DNS 由 OS 与 c-ares 并行兜底，模型调用不会对着失效端口重试；
- 后台探活，代理恢复或比 DSH 晚启动时自动切回。

两者都会安装进程级路由，语义互相覆盖，因此不要同时启用：保留本插件，禁用 `dsh-web-fetch-proxy`。

## 根因

两件事叠在一起：

1. **fake-ip**：TUN 模式下 DNS 对任何域名都返回合成地址（如 `198.18.0.22`、`fdfe:dcba:9876::ed`）。`web_fetch` 先本地解析、再逐条校验地址是否公网，任一条不合格就整体拒绝，连接根本没有发出去。
2. **进程级代理路由比代理进程活得久**：`@deepseek-ai/dsh-http-proxy` 把一条**进程级**代理策略装进 undici 的全局 dispatcher；`web_fetch` 正是靠 `proxyRouteFor()` 看到「已代理」才跳过本地 DNS 校验。把真实代理地址直接装进去后，代理关闭了这条路由仍然在，之后**所有**出站请求（包括模型 API）继续拨一个已经不存在的端口，连接被拒 → `dsh-llm-retry` 退避重试 → 仍然失败 → 回合中断。

换句话说：`web_fetch` 需要的「代理路由」和模型需要的「代理关闭后能直连」是同一个全局开关。把真实代理写死进去，就只能在两者之间二选一。

## 这个插件怎么做

插件不再把真实代理装成全局路由，而是先在本机起一个**只监听回环地址的小型 HTTP 代理（relay）**，把 relay 作为进程级路由。relay 在**每次请求时**决定怎么走：

```text
                 ┌──────────────────────────────┐
  模型 API ──────┤                              ├── 上游代理（Mihomo :7890）→ 网络
  web_fetch ─────┤   relay 127.0.0.1:<随机端口>  │
  MCP / 搜索 ────┤                              ├── 直连（上游不可用时，同一请求内切换）
                 └──────────────────────────────┘
```

- **上游可用**：隧道 / 转发到真实代理。`web_fetch` 依然拿到 `proxied` 路由，由代理侧解析域名，fake-ip 问题照旧被绕过。
- **上游已关闭**：relay 拨号失败后**立刻在同一个请求里**改走直连，模型调用不会对着失效端口重试；同时把上游标记为 down，后续请求不再徒劳去拨它。
- **代理重新打开**：后台探活（默认 1.5 秒一次）发现端口恢复，自动切回代理路径。
- **代理比 DSH 晚启动**：同样由后台探活自动接管，不需要重启 DSH。
- **连接不断**：客户端连接的是「永远在线」的 relay，代理的生死只会影响 relay 到上游那一段；已建立的双向隧道不会因为插件重载或 relay 关闭而被主动切断。

发现上游的顺序：显式配置 → `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`（大小写都读）→ Clash / Mihomo / Clash Verge 配置里的 `mixed-port` → 常见端口。环境变量与 Clash 配置视为可信；端口探测出来的候选会额外做一次 `CONNECT` 握手，避免把恰好占用 7890 的普通服务误当成代理。

## 安装

任选一种（`--profile web` 按实际 profile 替换）：

```bash
# GitHub 源码（当前唯一可用的远程方式）
dsh plugin --profile web add github:PILIHU2022/dsh-proxy-failover

# 本地目录（开发调试）
dsh plugin --profile web add link:/home/Projects/dsh-plugins/dsh-proxy-failover
```

包尚未发布到 npm，也没有 GitHub Release 预构建 tarball，所以没有按 npm 包名或 `.tgz` 安装的写法。npm 发布是可选的，不影响目录收录；发布之后才会有 `dsh plugin --profile web add dsh-proxy-failover`。

安装后 bundle patch 会插入一行：

```yaml
- insert:
    - id: proxy-failover
      name: dsh-proxy-failover
      config:
        proxy: auto
        noProxy: ""
```

更新插件代码后，重新启用该行（或重启 DSH）即可加载新代码。

> **与 [`dsh-web-fetch-proxy`](https://github.com/1499501762/dsh-web-fetch-proxy) 二选一。** 两者都会安装进程级路由，语义会互相覆盖。本插件在功能上是它的超集：既修 fake-ip，也修代理关闭后的模型重试。推荐保留本插件并**禁用 `dsh-web-fetch-proxy`**。

## 配置

写在 `cordis.patch.yml` 该行的 `config` 下（部署级），也可以用设置页面的 `proxy-failover` 命名空间热改 `proxy` / `noProxy`。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时完全不介入，保持宿主原有路由 |
| `proxy` | `auto` | `auto` 自动发现；`off` / `none` / `direct` 强制直连；也可写死 `http://127.0.0.1:7890` |
| `noProxy` | `""` | 追加到 `no_proxy`，逗号分隔；回环地址始终绕过 |
| `probeIntervalMs` | `1500` | 上游探活 / 重新发现间隔（代码默认值） |
| `probeTimeoutMs` | `400` | 单个候选端口 TCP 探测超时 |
| `connectTimeoutMs` | `10000` | relay 连接上游 / 目标的超时 |
| `handshakeTimeoutMs` | `10000` | 上游 `CONNECT` 握手超时 |
| `resolveTimeoutMs` | `5000` | 直连路径 DNS 总超时（OS 与 c-ares 并行，先到先用） |
| `listenPort` | `0` | relay 端口；`0` 表示随机端口，始终只监听 `127.0.0.1` |
| `candidatePorts` | `7890, 7897, 7891, 7899, 10809, 10808, 1080, 2080, 20171, 8889` | 端口探测候选 |

`proxy: auto` 的发现顺序见上一节。所有数值型字段都会被夹到安全区间内，非法值回退默认值。

## 状态与排障

只读状态接口（仅回环地址可访问，`GET`）：

```bash
curl -s http://127.0.0.1:3080/proxy-failover/status | jq
```

返回 `{ "ok": true, "value": { ... } }`，其中 `value` 的主要字段：

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
      "tunnels": { "active": 2, "closedOnProxyLoss": 0 },
      "dns": { "fallbacks": 1, "failures": 0, "lastMs": 12, "lastSource": "os" }
    },
    "proxy": { "proxy": "auto", "noProxy": "" },
    "candidates": [{ "url": "http://127.0.0.1:7890", "source": "port-probe:7890", "trusted": false }]
  }
}
```

- `routed: true`：`proxyRouteFor()` 确实指向本 relay，`web_fetch` 会跳过本地 DNS 校验。
- `upstreamUp: false` + `fallbacks > 0`：代理已经关闭，最近的请求走了直连。
- `requests` 统计所有经全局 dispatcher 的请求，包括模型 API、`web_fetch`、MCP。
- `tunnels.active` / `closedOnProxyLoss`：当前活跃隧道数，以及因上游丢失而被关闭的隧道数。

另有面板使用的动作接口 `POST /proxy-failover/api`，`{"action":"status"|"redetect"|"configure"}`；只接受 Host 为回环或已配置受信主机的请求，跨站请求被拒绝，带 `Origin` 时要求与该 Host 一致；写操作只允许改 `proxy` 与 `noProxy`。

日志里能看到的状态迁移：

```text
[proxy-failover] 上游代理已启用：http://127.0.0.1:7890（来源：port-probe:7890）
[proxy-failover] 上游代理 http://127.0.0.1:7890 不可用，后续请求自动直连：连接上游失败: connect ECONNREFUSED ...
[proxy-failover] 上游代理已启用：http://127.0.0.1:7890（来源：port-probe:7890）
```

## 安全性

- relay **只监听 `127.0.0.1`**，且拒绝把 `CONNECT` / 请求转发到回环、链路本地（含 `169.254.169.254` 云元数据）、组播、6to4、NAT64 等地址。
- 允许 RFC1918 / CGNAT / ULA 直连：全局路由会影响局域网内的模型端点与 MCP 服务，这与真实代理的直连行为一致；需要更严格时可在 `noProxy` 或代理规则里限制。
- `web_fetch` 的 SSRF 校验在「已代理」时本来就会被跳过，本插件沿用这一语义；上游可用时由代理决定去向，上游不可用时由 relay 做上述地址过滤。
- **fail-open**：模块求值、`apply()`、探活、状态接口全部包在 `try/catch` 里；安装失败会回滚 dispatcher 与环境变量，绝不把原本可用的网络改坏。
- 状态接口只读（仅返回快照），沿用同一套受信 Host 校验；跨站请求一律拒绝。

## 已知限制

- 只支持 `http(s)://` 代理，不支持 SOCKS / PAC（与 `@deepseek-ai/dsh-http-proxy` 一致）。
- 上游代理认证只支持 URL 里的 Basic 凭据。
- 代理若在**响应传输中途**被杀，已经建立的隧道仍会断开——这是传输层事实；插件保证的是「下一次请求」不需要重试，而不是让断掉的字节流复活。
- 端口探测依赖 `CONNECT example.com:443` 验证；完全离线时可能找不到代理，此时退回直连。
- `web_fetch` 的 fake-ip 修复依赖 `@deepseek-ai/dsh-http-proxy` 的实例身份；插件会通过 `DSH_HOME`、安装目录、`cwd` 等锚点解析，并在安装后自检 `routed`。

## 链接

- 仓库：`https://github.com/PILIHU2022/dsh-proxy-failover`
- 同类插件（仅修 fake-ip）：`https://github.com/1499501762/dsh-web-fetch-proxy`
- 中文说明：[README.md](../README.md)
- English README：[README.en.md](../README.en.md)
- 问题反馈：`https://github.com/PILIHU2022/dsh-proxy-failover/issues`
- 许可证：[MIT](../LICENSE)
- 市场条目（本目录）：[market-entry.json](./market-entry.json) · [投稿记录](./market-submission.md)
- 市场页：尚未生成（目录条目 PR 待合并，未收录）
