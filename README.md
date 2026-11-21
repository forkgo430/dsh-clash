# dsh-clash

Let the AI operate the local Clash (mihomo) kernel — switch nodes, test latency, check which rule a domain hits, and see live connections. No more clicking through the Clash Verge panel to answer "which node am I on?".

[中文说明](./README.zh.md)

## What it does

Eight tools over the mihomo REST API, so what you get is real state, not a guess:

- **List nodes and policy groups** — every group with its currently selected node
- **Switch nodes** — pick any member of any group
- **Test latency** — one node or a whole group, sorted fastest first
- **Switch mode** — `rule` (split by rules), `global` (everything via proxy), `direct` (bypass)
- **Inspect rules** — search ~10k routing rules, or temporarily disable one
- **Live connections** — destination, matched rule, node chain, bytes; drop one or all

## Setup (required)

Clash Verge ships with its API **disabled**. DSH needs it on TCP, but Clash Verge puts it on a Windows named pipe that only it can reach.

Edit `%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\verge.yaml`:

```yaml
enable_external_controller: true
```

Then **fully quit Clash Verge (tray included) and reopen it**. Confirm:

```powershell
Test-NetConnection -ComputerName 127.0.0.1 -Port 9097
```

`TcpTestSucceeded : True` means it worked.

The default secret is `set-your-secret`. If you changed it, update the plugin config to match.

## Install

```bash
dsh plugin --profile desktop add github:forkgo430/dsh-clash
```

Or point **Plugins → Add plugin** at a local directory.

Restart DSH afterwards — the tool list is built at session start.

## The tools

| Tool | Purpose |
|---|---|
| `clash_status` | Version, mode, port, TUN state, global exit node, group/node counts |
| `clash_groups` | All policy groups with their selected node; filterable |
| `clash_nodes` | Members of one group, with last measured latency |
| `clash_select` | Switch a group to a node |
| `clash_delay` | Test one node or a whole group |
| `clash_mode` | Read or set `rule` / `global` / `direct` |
| `clash_rules` | Search rules, or toggle one off and back on |
| `clash_connections` | Live connections and traffic; close one or all |

## Typical flows

**A site won't load**

```
clash_status              is the kernel alive, what mode
clash_delay <group>       all timeouts means your subscription is dead
clash_connections         which rule and node that domain takes
```

**Make a node switch take effect immediately**

Switching only affects new connections; established ones keep the old node.

```
clash_select <group> <node>
clash_connections closeAll=true
```

**Let one site bypass the proxy temporarily**

```
clash_rules filter=example.com     find the rule index
clash_rules disableIndex=12 disable=true
```

## What it deliberately does not do

- **System proxy switch** — that is a Windows registry write, outside the API. Use Clash Verge's toggle or Windows settings.
- **TUN mode** — needs admin rights to load the wintun adapter and a config change plus kernel restart. Not switchable over the API. Use the GUI.
- **Start or stop the kernel** — Clash Verge owns the process. This plugin only speaks HTTP and reports clearly when the kernel is down.
- **DSH's own outbound traffic** — Node's `fetch` does not read the Windows registry proxy, so flipping the system proxy does not affect DSH's own requests. Set `HTTPS_PROXY` separately if you need that.

## Volatility

| Action | After a kernel restart |
|---|---|
| Node switch | Reverts to the config default |
| Mode switch | Persists (with `store-selected`) |
| Rule disabled | Re-enabled |
| Dropped connections | No effect |

For persistence, change the Clash Verge config or the subscription itself.

## Errors you may see

**"Cannot reach the Clash kernel"** — Clash Verge is not running, `enable_external_controller` is still `false`, or the port is not 9097.

**"HTTP 401"** — secret mismatch. Check `secret:` at the top of `clash-verge.yaml`.

**"All latency tests timed out"** — the plugin is fine; the subscription nodes are dead. Update or replace the subscription in Clash Verge.

## License

MIT. It talks to mihomo over HTTP and bundles no GPL code.