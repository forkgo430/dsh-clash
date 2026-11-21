# Clash 代理控制

把本机 Clash（mihomo）内核的能力交给 AI：看节点、切节点、测延迟、切模式、查规则、看连接。

## 前置条件（必须先做）

DSH 通过 mihomo 的 REST API 工作，而这个 API 在 Clash Verge 里默认是关的。

编辑 `%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\verge.yaml`，把

```yaml
enable_external_controller: false
```

改成

```yaml
enable_external_controller: true
```

然后**完全退出 Clash Verge 再重新打开**（托盘退出，只关窗口不够）。重启后 9097 端口开始监听，可以这样确认：

```powershell
Test-NetConnection -ComputerName 127.0.0.1 -Port 9097
```

`TcpTestSucceeded : True` 就通了。

如果改过 secret，把它同步到本插件配置（默认是 Clash Verge 写的 `set-your-secret`）。

## 八个工具

| 工具 | 用途 |
|---|---|
| `clash_status` | 版本、模式、端口、TUN、全局出口、组数节点数。排查第一步 |
| `clash_groups` | 列出策略组及当前选中节点；可按名称过滤 |
| `clash_nodes` | 某个组的全部成员 + 最近延迟 |
| `clash_select` | 在某组内切换节点 |
| `clash_delay` | 测整组或单节点延迟 |
| `clash_mode` | 查看或切换 rule / global / direct |
| `clash_rules` | 查规则，或临时启用/禁用某条 |
| `clash_connections` | 看活动连接与流量；可断单条或全部 |

## 典型用法

**排查「某站点打不开」**

```
clash_status          → 确认内核活着、当前什么模式
clash_delay 节点组     → 节点是否全超时（全超时 = 订阅失效）
clash_connections     → 看那个域名走的哪条规则、哪个节点
```

**换节点后让新配置立刻生效**

切换节点只影响新建连接，已建立的连接还在走旧节点。所以切完要断掉：

```
clash_select  节点组  日本01
clash_connections  closeAll=true
```

**临时让某个站点直连**

```
clash_rules  filter=example.com     → 找到对应规则索引
clash_rules  disableIndex=12  disable=true
```

## 边界

**这个插件不管的：**

- **系统代理开关** —— 那要改 Windows 注册表，不属于 API 范围。要关代理请用 Clash Verge 的开关，或者手动改系统设置。
- **TUN 模式** —— 需要管理员权限加载 wintun 网卡驱动，只能在配置里写死 `tun.enable` 后重启内核，API 无法动态切换。请用 Clash Verge 界面。
- **起停内核** —— 内核进程归 Clash Verge 管。插件只发 HTTP 请求，内核没开就报错告诉你。
- **DSH 自己的出站流量** —— 改系统代理对 DSH 主进程无效（Node 的 fetch 不读 Windows 注册表）。如果你想让 DSH 走代理，需要另外设 `HTTPS_PROXY` 环境变量。

**内存态 vs 持久态**

| 操作 | 重启内核后 |
|---|---|
| 切节点 | 回到配置文件默认 |
| 切模式 | 保持（若 `store-selected` 开启） |
| 禁用规则 | 恢复启用 |
| 断连接 | 无影响 |

想持久化，得改 Clash Verge 里的配置或订阅。

## 常见报错

**「连不上 Clash 内核」** —— Clash Verge 没运行，或 `enable_external_controller` 还是 false，或端口不是 9097。

**「HTTP 401」** —— secret 不匹配。看 `clash-verge.yaml` 顶部的 `secret:` 值，同步到插件配置。

**「测延迟全部超时」** —— 这不是插件问题，是订阅节点失效了。去 Clash Verge 里换订阅或更新节点。
