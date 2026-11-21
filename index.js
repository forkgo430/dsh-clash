/**
 * dsh-clash —— 把 mihomo（Clash 内核）的 REST API 包装成 agent 可调用的工具。
 *
 * 设计边界（刻意为之）：
 * - 只发 HTTP 请求，**不**起停内核、**不**读写注册表、**不**改配置文件。
 *   进程生命周期与系统代理开关仍归 Clash Verge 的 GUI 管，这里不越界。
 * - 因此这里所有失败都是「请求失败」，不会把整机网络搞挂。
 *
 * 依赖的前置条件（由用户一次性配置）：
 * Clash Verge 的 verge.yaml 里 `enable_external_controller: true`，
 * 内核会在 9097 上开 TCP 版 REST API。
 *
 * 为什么不用 `defineTool`：那个函数来自 `@deepseek-ai/dsh-tools`，是 dsh 安装
 * 目录里的内置包，profile 里解析不到。第三方 bundle 装进 profile 后只能拿到
 * `ctx.tools` 服务，所以这里直接产出 registry 需要的形状：
 * `{ name, description, parameters, output: { schema, render }, execute }`。
 * `parameters` 与 `output.schema` 都必须是**原生 JSON Schema 对象**，不是
 * schemastery 的 spec —— registry 会用 `projectToolSchema` 直接快照它。
 *
 * 同理**不导出 `Config`**：那需要 `@deepseek-ai/schemastery`，而 profile 通过
 * `link:` 装本地目录时，Node 的模块解析到不了 profile 的 node_modules
 * （pnpm 也会警告 "The linked in dependency will not resolve the peer
 * dependencies"）。没有 `Config` 导出时 loader 跳过校验、把 row 的 config
 * 原样传给 `apply`，这里就地做归一化与默认值，行为一致而依赖为零。
 *
 * @module dsh-clash
 */

export const name = 'clash'
export const inject = ['tools']

/** mihomo 合法的三种出站模式。 */
const MODES = ['rule', 'global', 'direct']

/**
 * 就地归一化 row 的 config。
 *
 * 缺省值与 `cordis.patch.yml` 里写的一致；类型不对的值一律回落到默认，
 * 而不是让插件在第一次调用时才炸 —— 配置错误应该在激活时就表现为可用状态。
 */
function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const apiBase =
    typeof source.apiBase === 'string' && source.apiBase.trim().length > 0
      ? source.apiBase.trim().replace(/\/+$/, '')
      : 'http://127.0.0.1:9097'
  const secret = typeof source.secret === 'string' ? source.secret : ''
  const rawTimeout = Number(source.timeoutMs)
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 10000
  return { apiBase, secret, timeoutMs }
}

/** 把本模块的工具声明收敛成 registry 接受的形状。 */
function tool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters ?? { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: spec.outputSchema,
      render: spec.render,
    },
    execute: spec.execute,
    ...(spec.presentCall === undefined ? {} : { presentCall: spec.presentCall }),
  }
}

/**
 * 调一次 mihomo 的 REST API。
 *
 * 统一的错误口径：网络不通、鉴权失败、HTTP 非 2xx、响应不是 JSON —— 四种都转成
 * 带诊断线索的 Error，让模型能据此判断是「内核没开」「secret 不对」还是「接口没有」。
 *
 * @param {object} cfg - 插件配置。
 * @param {string} path - 以 / 开头的 API 路径，含查询串。
 * @param {object} [opts] - method 与 body。
 * @returns {Promise<any>} 解析后的 JSON；204 无体时返回 null。
 */
async function api(cfg, path, opts = {}) {
  const { method = 'GET', body, timeoutMs } = opts
  const url = `${cfg.apiBase.replace(/\/+$/, '')}${path}`
  const headers = { Accept: 'application/json' }
  if (cfg.secret.length > 0) headers.Authorization = `Bearer ${cfg.secret}`
  let payload
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }

  let res
  try {
    res = await fetch(url, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
      signal: AbortSignal.timeout(timeoutMs ?? cfg.timeoutMs),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `连不上 Clash 内核（${cfg.apiBase}）：${detail}。` +
        '检查两件事：Clash Verge 是否在运行；verge.yaml 里 enable_external_controller 是否为 true。'
    )
  }

  if (res.status === 401) {
    throw new Error(
      `Clash 内核拒绝了鉴权（HTTP 401）。当前 secret 与内核不一致 —— ` +
        '核对 clash-verge.yaml 顶部的 secret，并同步到本插件配置。'
    )
  }
  if (res.status === 204) return null
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Clash API ${method} ${path} 返回 HTTP ${res.status}：${text.slice(0, 300)}`)
  }
  const text = await res.text()
  if (text.trim().length === 0) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Clash API ${method} ${path} 的响应不是 JSON：${text.slice(0, 200)}`)
  }
}

/** 把字节数换成易读单位，连接列表里用。 */
function humanBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/**
 * 从 /proxies 的全量结果里挑出策略组。
 *
 * 判据是「有 all 数组」—— 这是 mihomo 对 Selector/URLTest/Fallback/LoadBalance
 * 四种组的共同标识，普通节点没有这个字段。
 */
function pickGroups(proxies) {
  return Object.entries(proxies)
    .filter(([, v]) => v !== null && typeof v === 'object' && Array.isArray(v.all))
    .map(([groupName, v]) => ({
      group: groupName,
      type: v.type,
      now: typeof v.now === 'string' ? v.now : null,
      members: v.all.length,
    }))
}

/** 注册全部 clash_* 工具。 */
export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)

  const tools = []

  tools.push(
    tool({
      name: 'clash_status',
      description:
        '查看本机 Clash 内核的整体状态：版本、出站模式、混合端口、TUN 是否开启、当前全局出口节点、策略组与节点数量。排查网络问题的第一步。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          version: { type: 'string' },
          mode: { type: 'string' },
          mixedPort: { type: 'integer' },
          tunEnabled: { type: 'boolean' },
          globalNode: { type: 'string' },
          groupCount: { type: 'integer' },
          nodeCount: { type: 'integer' },
          summary: { type: 'string' },
        },
        required: ['version', 'mode', 'mixedPort', 'tunEnabled', 'globalNode', 'groupCount', 'nodeCount', 'summary'],
      },
      render: (_args, v) => [{ type: 'text', text: v.summary }],
      async execute() {
        const [version, conf, proxies] = await Promise.all([
          api(cfg, '/version'),
          api(cfg, '/configs'),
          api(cfg, '/proxies'),
        ])
        const groups = pickGroups(proxies.proxies)
        const global = proxies.proxies.GLOBAL
        const globalNode = global && typeof global.now === 'string' ? global.now : ''
        const mixedPort = Number(conf['mixed-port'] ?? conf.port ?? 0)
        const tunEnabled = conf.tun?.enable === true

        const summary = [
          `Clash ${version?.version ?? '(未知版本)'}`,
          `模式 ${conf.mode}`,
          `混合端口 ${mixedPort}`,
          `TUN ${tunEnabled ? '已开启' : '未开启'}`,
          `全局出口 ${globalNode || '(未选择)'}`,
          `${groups.length} 个策略组 / ${Object.keys(proxies.proxies).length} 个条目`,
        ].join(' · ')

        return {
          version: String(version?.version ?? ''),
          mode: String(conf.mode ?? ''),
          mixedPort,
          tunEnabled,
          globalNode,
          groupCount: groups.length,
          nodeCount: Object.keys(proxies.proxies).length,
          summary,
        }
      },
      presentCall: () => ({ card: 'generic', title: 'Clash 状态', kind: 'other' }),
    })
  )

  tools.push(
    tool({
      name: 'clash_groups',
      description:
        '列出所有策略组（节点选择器）及其当前选中的节点。分组是 Clash 的调度单位：切换节点要针对具体分组，不同分组可以走不同出口。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          filter: { type: 'string', description: '只返回名称包含该子串的分组，空串表示不筛选。' },
        },
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groups: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                group: { type: 'string' },
                type: { type: 'string' },
                now: { type: 'string' },
                members: { type: 'integer' },
              },
              required: ['group', 'type', 'now', 'members'],
            },
          },
          total: { type: 'integer' },
          summary: { type: 'string' },
        },
        required: ['groups', 'total', 'summary'],
      },
      render: (_args, v) => [{ type: 'text', text: v.summary }],
      async execute(args) {
        const proxies = await api(cfg, '/proxies')
        const needle = (args.filter ?? '').trim()
        let groups = pickGroups(proxies.proxies)
        if (needle.length > 0) groups = groups.filter((g) => g.group.includes(needle))

        const lines = groups.map(
          (g) => `[${g.type}] ${g.group} → ${g.now || '(未选择)'}  (${g.members} 个成员)`
        )
        return {
          groups: groups.map((g) => ({
            group: g.group,
            type: g.type,
            now: g.now ?? '',
            members: g.members,
          })),
          total: groups.length,
          summary: groups.length === 0 ? '没有匹配的策略组。' : lines.join('\n'),
        }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Clash 策略组',
        kind: 'other',
        rawInput: args.filter ?? '',
      }),
    })
  )

  tools.push(
    tool({
      name: 'clash_nodes',
      description:
        '列出某个策略组的全部成员节点，附带最近一次测得的延迟。用于挑节点；不看分组直接列全部节点会很长，建议先 clash_groups 再查具体组。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group: {
            type: 'string',
            description: '策略组名称，取自 clash_groups 的返回值，需完全一致（含 emoji）。',
          },
        },
        required: ['group'],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group: { type: 'string' },
          now: { type: 'string' },
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                alive: { type: 'boolean' },
                delayMs: { type: 'integer' },
                selected: { type: 'boolean' },
              },
              required: ['name', 'type', 'alive', 'delayMs', 'selected'],
            },
          },
          summary: { type: 'string' },
        },
        required: ['group', 'now', 'nodes', 'summary'],
      },
      render: (_args, v) => [{ type: 'text', text: v.summary }],
      async execute(args) {
        const proxies = await api(cfg, '/proxies')
        const target = proxies.proxies[args.group]
        if (target === undefined) {
          throw new Error(`没有名为 ${JSON.stringify(args.group)} 的策略组。先用 clash_groups 查可用名称。`)
        }
        const memberNames = Array.isArray(target.all) ? target.all : []
        const now = typeof target.now === 'string' ? target.now : ''

        const nodes = memberNames.map((memberName) => {
          const member = proxies.proxies[memberName]
          const history = Array.isArray(member?.history) ? member.history : []
          const last = history.length > 0 ? history[history.length - 1] : undefined
          const delay = last && typeof last.delay === 'number' ? last.delay : -1
          return {
            name: memberName,
            type: String(member?.type ?? '(非节点)'),
            alive: member?.alive !== false,
            delayMs: delay,
            selected: memberName === now,
          }
        })

        const lines = nodes.map(
          (n) =>
            `${n.selected ? '✔' : ' '} ${n.name}  [${n.type}]  ${
              n.delayMs < 0 ? '未测' : `${n.delayMs}ms`
            }`
        )
        return {
          group: args.group,
          now,
          nodes,
          summary: `${args.group}（当前 ${now || '未选择'}，共 ${nodes.length} 个成员）\n${lines.join(
            '\n'
          )}`,
        }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Clash 节点',
        kind: 'other',
        rawInput: args.group,
      }),
    })
  )

  tools.push(
    tool({
      name: 'clash_select',
      description:
        '在指定策略组里切换到某个节点。切换是即时的、内存态的：内核重启或配置重载后会回到配置文件里的默认值。已建立的连接不受影响，要立刻生效请配合 clash_connections 关闭连接。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group: { type: 'string', description: '策略组名称，取自 clash_groups。' },
          node: {
            type: 'string',
            description: '该组内的成员名称，取自 clash_nodes，需完全一致（含 emoji）。',
          },
        },
        required: ['group', 'node'],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group: { type: 'string' },
          previous: { type: 'string' },
          current: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['group', 'previous', 'current', 'summary'],
      },
      render: (_args, v) => [{ type: 'text', text: v.summary }],
      async execute(args) {
        const before = await api(cfg, '/proxies')
        const target = before.proxies[args.group]
        if (target === undefined) {
          throw new Error(`没有名为 ${JSON.stringify(args.group)} 的策略组。先用 clash_groups 查可用名称。`)
        }
        const members = Array.isArray(target.all) ? target.all : []
        if (!members.includes(args.node)) {
          throw new Error(
            `${JSON.stringify(args.node)} 不在策略组 ${JSON.stringify(args.group)} 里。` +
              `该组成员：${members.slice(0, 12).join(' / ')}${members.length > 12 ? ' …' : ''}`
          )
        }
        const previous = typeof target.now === 'string' ? target.now : ''

        await api(cfg, `/proxies/${encodeURIComponent(args.group)}`, {
          method: 'PUT',
          body: { name: args.node },
        })

        const after = await api(cfg, '/proxies')
        const current = after.proxies[args.group]?.now ?? args.node

        return {
          group: args.group,
          previous,
          current,
          summary: `${args.group}：${previous || '(未选择)'} → ${current}`,
        }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: '切换节点',
        kind: 'other',
        rawInput: `${args.group} → ${args.node}`,
      }),
    })
  )

  tools.push(
    tool({
      name: 'clash_delay',
      description:
        '测延迟。给 group 就测该组全部成员（较慢），给 group + node 就测单个。返回毫秒数或超时 —— 全部超时通常说明订阅节点已失效，而不是配置写错了。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group: {
            type: 'string',
            description: '策略组名称；测单个节点时也填它所属的组。',
          },
          node: { type: 'string', description: '只测这一个成员。省略则测整组。' },
          url: {
            type: 'string',
            description: '测速目标地址，默认 http://www.gstatic.com/generate_204。',
          },
          timeoutMs: { type: 'integer', description: '单个节点的超时毫秒数，默认 5000。' },
        },
        required: ['group'],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                delayMs: { type: 'integer' },
                reachable: { type: 'boolean' },
              },
              required: ['name', 'delayMs', 'reachable'],
            },
          },
          summary: { type: 'string' },
        },
        required: ['results', 'summary'],
      },
      render: (_args, v) => [{ type: 'text', text: v.summary }],
      async execute(args) {
        const testUrl = (args.url ?? 'http://www.gstatic.com/generate_204').trim()
        const perNodeTimeout = args.timeoutMs ?? 5000
        const single = args.node !== undefined && args.node.length > 0
        const path = single
          ? `/proxies/${encodeURIComponent(args.node)}/delay`
          : `/group/${encodeURIComponent(args.group)}/delay`
        const query = `?url=${encodeURIComponent(testUrl)}&timeout=${perNodeTimeout}`

        let raw
        try {
          raw = await api(cfg, `${path}${query}`, {
            timeoutMs: Math.max(cfg.timeoutMs, perNodeTimeout + 5000),
          })
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          // 504 是内核告诉我们「这个节点在超时时间内没通」，不是接口坏了。
          if (detail.includes('HTTP 504')) {
            return {
              results: [{ name: args.node ?? args.group, delayMs: -1, reachable: false }],
              summary:
                `${args.node ?? args.group} 测速超时（${perNodeTimeout}ms 内无响应）。\n` +
                '这通常意味着该节点或整个订阅已失效 —— 去 Clash Verge 检查订阅，不是插件的问题。',
            }
          }
          throw new Error(`测延迟失败：${detail}`)
        }

        let results
        if (raw !== null && typeof raw === 'object' && typeof raw.delay === 'number') {
          results = [{ name: args.node ?? args.group, delayMs: raw.delay, reachable: raw.delay > 0 }]
        } else if (raw !== null && typeof raw === 'object') {
          results = Object.entries(raw).map(([entryName, delay]) => ({
            name: entryName,
            delayMs: typeof delay === 'number' ? delay : -1,
            reachable: typeof delay === 'number' && delay > 0,
          }))
        } else {
          results = []
        }

        results.sort((a, b) => {
          if (a.reachable !== b.reachable) return a.reachable ? -1 : 1
          return a.delayMs - b.delayMs
        })

        const lines = results.map((r) => `${r.reachable ? `${r.delayMs}ms` : '超时'}  ${r.name}`)
        const okCount = results.filter((r) => r.reachable).length
        const head =
          results.length === 0 ? '没有拿到任何测速结果。' : `${okCount}/${results.length} 个节点可达。`
        const tail =
          results.length > 0 && okCount === 0
            ? '\n全部超时：通常是订阅节点已失效或上游不可用，先检查 Clash Verge 里的订阅。'
            : ''

        return { results, summary: head + '\n' + lines.join('\n') + tail }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: '测延迟',
        kind: 'other',
        rawInput: args.node ?? args.group,
      }),
    })
  )

  tools.push(
    tool({
      name: 'clash_mode',
      description:
        '查看或切换出站模式。rule 按规则分流（默认，国内直连国外走节点）；global 全部走代理；direct 全部直连（等于临时停用代理）。省略 mode 参数即为只查看。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: MODES, description: '要切换到的模式；省略则只返回当前模式。' },
        },
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          previous: { type: 'string' },
          current: { type: 'string' },
          changed: { type: 'boolean' },
          summary: { type: 'string' },
        },
        required: ['previous', 'current', 'changed', 'summary'],
      },
      render: (_args, v) => [{ type: 'text', text: v.summary }],
      async execute(args) {
        const conf = await api(cfg, '/configs')
        const previous = String(conf.mode ?? '')
        const wanted = args.mode
        if (wanted === undefined || wanted.length === 0) {
          return {
            previous,
            current: previous,
            changed: false,
            summary: `当前模式：${previous}。可选 rule / global / direct。`,
          }
        }
        if (wanted === previous) {
          return { previous, current: previous, changed: false, summary: `已经是 ${wanted}，未做改动。` }
        }
        await api(cfg, '/configs', { method: 'PATCH', body: { mode: wanted } })
        const after = await api(cfg, '/configs')
        const current = String(after.mode ?? wanted)
        const meaning =
          { rule: '按规则分流', global: '全部走代理', direct: '全部直连' }[current] ?? ''
        return {
          previous,
          current,
          changed: current !== previous,
          summary: `模式：${previous} → ${current}（${meaning}）`,
        }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Clash 模式',
        kind: 'other',
        rawInput: args.mode ?? '(查看)',
      }),
    })
  )

  tools.push(
    tool({
      name: 'clash_rules',
      description:
        '查看分流规则，或临时启用/禁用某条规则。规则按索引从上往下匹配，第一条命中的决定出口。禁用是内存态的，内核重启后失效。规则可能有近万条，用 filter 缩小范围。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          filter: {
            type: 'string',
            description: '只返回 payload 或 proxy 包含该子串的规则，空串表示全部。',
          },
          limit: { type: 'integer', description: '最多返回多少条，默认 40，避免一次拉几千条规则。' },
          disableIndex: { type: 'integer', description: '要改状态的规则索引（取自本工具的返回）。' },
          disable: {
            type: 'boolean',
            description: '配合 disableIndex：true 禁用该规则，false 恢复启用。',
          },
        },
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rules: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer' },
                type: { type: 'string' },
                payload: { type: 'string' },
                proxy: { type: 'string' },
                disabled: { type: 'boolean' },
              },
              required: ['index', 'type', 'payload', 'proxy', 'disabled'],
            },
          },
          total: { type: 'integer' },
          summary: { type: 'string' },
        },
        required: ['rules', 'total', 'summary'],
      },
      render: (_args, v) => [{ type: 'text', text: v.summary }],
      async execute(args) {
        let toggleNote = ''
        if (args.disableIndex !== undefined) {
          const on = args.disable !== false
          await api(cfg, '/rules/disable', {
            method: 'PATCH',
            body: { [String(args.disableIndex)]: on },
          })
          toggleNote = `规则 #${args.disableIndex} 已${on ? '禁用' : '恢复'}。\n`
        }

        const data = (await api(cfg, '/rules')) ?? {}
        const all = Array.isArray(data.rules) ? data.rules : []
        const needle = (args.filter ?? '').trim().toLowerCase()
        const limit = args.limit ?? 40

        let picked = all.map((r, i) => ({
          index: typeof r.index === 'number' ? r.index : i,
          type: String(r.type ?? ''),
          payload: String(r.payload ?? ''),
          proxy: String(r.proxy ?? ''),
          disabled: r.extra?.disabled === true,
        }))
        if (needle.length > 0) {
          picked = picked.filter(
            (r) =>
              r.payload.toLowerCase().includes(needle) || r.proxy.toLowerCase().includes(needle)
          )
        }
        const shown = picked.slice(0, Math.max(1, limit))
        const lines = shown.map(
          (r) => `${r.disabled ? '✕' : ' '} #${r.index} ${r.type},${r.payload} → ${r.proxy}`
        )
        const omitted = picked.length - shown.length
        const summary =
          toggleNote +
          `规则共 ${all.length} 条，匹配 ${picked.length} 条` +
          (omitted > 0
            ? `，显示前 ${shown.length} 条（省略 ${omitted} 条，可调小 filter 或加大 limit）`
            : '') +
          '\n' +
          lines.join('\n')

        return { rules: shown, total: all.length, summary }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Clash 规则',
        kind: 'other',
        rawInput: args.filter ?? '',
      }),
    })
  )

  tools.push(
    tool({
      name: 'clash_connections',
      description:
        '查看当前活动的连接：每条的目标地址、命中规则、走的节点链、已传输字节。也可以关闭连接（全部或单条）—— 改完规则或切换节点后，旧连接不会自动重连，需要在这里断掉。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', description: '最多返回多少条，默认 20。' },
          closeAll: {
            type: 'boolean',
            description: '关闭全部连接。切换节点或改规则后想让新配置立刻生效时用。',
          },
          closeId: { type: 'string', description: '关闭指定连接，id 取自本工具的返回。' },
        },
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          activeCount: { type: 'integer' },
          downloadTotal: { type: 'string' },
          uploadTotal: { type: 'string' },
          connections: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                host: { type: 'string' },
                destination: { type: 'string' },
                rule: { type: 'string' },
                chain: { type: 'string' },
                download: { type: 'string' },
                upload: { type: 'string' },
              },
              required: ['id', 'host', 'destination', 'rule', 'chain', 'download', 'upload'],
            },
          },
          summary: { type: 'string' },
        },
        required: ['activeCount', 'downloadTotal', 'uploadTotal', 'connections', 'summary'],
      },
      render: (_args, v) => [{ type: 'text', text: v.summary }],
      async execute(args) {
        let closeNote = ''
        if (args.closeId !== undefined && args.closeId.length > 0) {
          await api(cfg, `/connections/${encodeURIComponent(args.closeId)}`, { method: 'DELETE' })
          closeNote = `已关闭连接 ${args.closeId}。\n`
        } else if (args.closeAll === true) {
          await api(cfg, '/connections', { method: 'DELETE' })
          closeNote = '已关闭全部连接。\n'
        }

        const data = (await api(cfg, '/connections')) ?? {}
        // 实测 mihomo v1.19.29 在没有活动连接时返回 connections: null，不是空数组。
        const all = Array.isArray(data.connections) ? data.connections : []
        const limit = args.limit ?? 20

        const mapped = all.slice(0, Math.max(1, limit)).map((c) => {
          const meta = c.metadata ?? {}
          const host = String(meta.host ?? '')
          const dest = `${meta.destinationIP ?? ''}:${meta.destinationPort ?? ''}`
          const chain = Array.isArray(c.chains) ? c.chains.join(' ← ') : ''
          return {
            id: String(c.id ?? ''),
            host: host.length > 0 ? host : dest,
            destination: dest,
            rule: `${c.rule ?? ''}${c.rulePayload ? `,${c.rulePayload}` : ''}`,
            chain,
            download: humanBytes(c.download),
            upload: humanBytes(c.upload),
          }
        })

        const lines = mapped.map(
          (c) => `${c.host}  [${c.rule || '-'}]  ${c.chain || '-'}  ↓${c.download} ↑${c.upload}`
        )
        const omitted = all.length - mapped.length
        const summary =
          closeNote +
          `活动连接 ${all.length} 条，累计 ↓${humanBytes(data.downloadTotal)} ↑${humanBytes(
            data.uploadTotal
          )}` +
          (omitted > 0 ? `（显示 ${mapped.length} 条，省略 ${omitted} 条）` : '') +
          (all.length === 0 ? '' : '\n' + lines.join('\n'))

        return {
          activeCount: all.length,
          downloadTotal: humanBytes(data.downloadTotal),
          uploadTotal: humanBytes(data.uploadTotal),
          connections: mapped,
          summary,
        }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: args.closeAll === true ? '关闭全部连接' : 'Clash 连接',
        kind: 'other',
      }),
    })
  )

  // 用 ctx.effect 登记，返回 disposer 的收集器；ctx.tools.register 自身返回 disposer。
  const disposers = tools.map((definition) => ctx.tools.register(definition))
  ctx.on?.('dispose', () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {
        /* 卸载期忽略 */
      }
    }
  })

  ctx.logger?.info?.(
    `[dsh-clash] 已注册 ${tools.length} 个工具，目标内核 ${cfg.apiBase}` +
      (cfg.secret.length > 0 ? '（带 secret）' : '（无 secret）')
  )
}