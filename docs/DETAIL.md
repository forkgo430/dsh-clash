# Clash 代理控制

让 AI 直接操作本机的 Clash（mihomo）内核，不用你手动点 GUI。

## 它解决什么

以前想换个节点、看看哪个网站走了哪条规则、确认订阅是不是废了，都得自己开 Clash Verge 点面板。现在直接问 AI 就行：

- 「现在走的是哪个节点？」
- 「这个组的节点都测一下，哪个最快」
- 「切到日本」
- 「example.com 为什么打不开，走的是直连还是代理」
- 「临时让 example.com 直连」

底层是 mihomo 的 REST API，所以拿到的是真实状态，不是猜的。

## 前置条件

Clash Verge 默认把 API 关了。去

```
%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\verge.yaml
```

把 `enable_external_controller: false` 改成 `true`，然后**托盘退出 Clash Verge 再重开**。

重启后这样确认：

```powershell
Test-NetConnection -ComputerName 127.0.0.1 -Port 9097
```

看到 `TcpTestSucceeded : True` 就成了。

secret 默认是 `set-your-secret`，改过就同步到插件配置里。

## 八个工具

| 工具 | 干什么 |
|---|---|
| `clash_status` | 内核版本、出站模式、混合端口、TUN 状态、当前全局出口、组和节点数量 |
| `clash_groups` | 所有策略组及各自选中的节点，可按名称过滤 |
| `clash_nodes` | 某个组的全部成员，带最近一次延迟 |
| `clash_select` | 在组内切节点 |
| `clash_delay` | 测延迟，整组或单个都行 |
| `clash_mode` | 看/切 rule（规则分流）、global（全走代理）、direct（全直连） |
| `clash_rules` | 查分流规则，或临时禁用/恢复某条 |
| `clash_connections` | 看活动连接、命中规则、节点链、流量；可断单条或全部 |

## 三个实用场景

**排查某个站打不开**

```
clash_status              内核活着吗，什么模式
clash_delay 节点组         节点全超时就是订阅废了
clash_connections         那个域名走了哪条规则
```

**切完节点要断连接**

切节点只影响新连接，老连接还在走旧节点。所以：

```
clash_select 节点组 日本01
clash_connections closeAll=true
```

**临时让某站直连**

```
clash_rules filter=example.com      找到规则索引
clash_rules disableIndex=12 disable=true
```

## 它不管什么

**系统代理开关** —— 那是 Windows 注册表的事，不在 API 范围内。要关代理还是得用 Clash Verge 的开关或者系统设置。

**TUN 模式** —— 要管理员权限加载网卡驱动，只能在配置里写死然后重启内核，API 切不了。去 GUI 点。

**起停内核** —— 内核归 Clash Verge 管。插件只发 HTTP，内核没开就直接报错告诉你。

**DSH 自己的流量** —— Node 的 fetch 不读 Windows 注册表代理，改系统代理对 DSH 主进程无效。想让 DSH 走代理得单独设 `HTTPS_PROXY`。

## 内存态提醒

| 操作 | 重启内核后 |
|---|---|
| 切节点 | 回到配置默认 |
| 切模式 | 保持 |
| 禁用规则 | 恢复启用 |
| 断连接 | 无影响 |

想持久化就去改 Clash Verge 的配置或订阅本身。

## 报错含义

**连不上内核** —— Clash Verge 没开，或 `enable_external_controller` 还是 false，或端口不是 9097。

**HTTP 401** —— secret 不对。看 `clash-verge.yaml` 顶部的 `secret:` 值。

**测延迟全超时** —— 插件没坏，是订阅节点死了。去 Clash Verge 换订阅。