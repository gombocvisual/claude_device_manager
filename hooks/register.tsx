import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Device } from '../types'

const PANE = 'device-switcher'
const STORE_DEVICES = 'devices'
const STORE_ACTIVE = 'active'

const devices = atom({ plugin: 'device-switcher', key: 'devices' } as const, [] as Device[], {
  shape: 'devices-1',
})
const active = atom({ plugin: 'device-switcher', key: 'active' } as const, '', {
  shape: 'active-1',
})
const message = atom({ plugin: 'device-switcher', key: 'message' } as const, '')
const sshHosts = atom({ plugin: 'device-switcher', key: 'sshHosts' } as const, [] as string[])

// Local file tools cannot reach a remote device: while one is active they are
// refused, and the model is told to go through Bash, which runs over ssh.
const LOCAL_ONLY_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'LS',
  'PowerShell',
])
// Claude's own scratch files (saved tool output, plans) stay local.
const CLAUDE_OWN_PATH = /[\\/]\.claude[\\/]|[\\/]Temp[\\/]claude[\\/]/i

/** Quote for a POSIX shell. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

const cdPart = (dir?: string) => {
  if (!dir) return ''
  if (dir === '~') return 'cd && '
  if (dir.startsWith('~/')) return `cd ~/${q(dir.slice(2))} && `

  return `cd ${q(dir)} && `
}

const sshArgs = (d: Device) => [
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
  ...(d.port ? ['-p', String(d.port)] : []),
  d.target,
]

const label = (d: Device) =>
  `${d.name} (${d.target}${d.port ? `:${d.port}` : ''}${d.dir ? ` ${d.dir}` : ''})`

/** "name user@host[:port] [dir]" or "user@host[:port] [dir]" */
const parseDevice = (text: string): Device | string => {
  const parts = text.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '請輸入：名稱 user@host[:port] [遠端資料夾]'
  let name: string | undefined
  let rest = parts
  if (parts.length >= 2 && !parts[0]!.includes('@') && parts[1]!.includes('@')) {
    name = parts[0]
    rest = parts.slice(1)
  }
  const [conn, dir] = rest
  if (!conn) return '缺少連線位址 (user@host)'
  const m = /^([^\s:]+?)(?::(\d+))?$/.exec(conn)
  if (!m) return `看不懂的位址：${conn}`
  const target = m[1]!
  const port = m[2] ? Number(m[2]) : undefined
  const host = target.includes('@') ? target.split('@')[1]! : target

  return {
    id: `${target}:${port ?? 22}:${Date.now().toString(36)}`,
    name: name ?? host,
    target,
    ...(port ? { port } : {}),
    ...(dir ? { dir } : {}),
  }
}

const loadSshHosts = async ($: EngineInterface) => {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (!home) return []
  const path = `${home}/.ssh/config`
  if (!(await $.fs.exists(path))) return []
  const text = await $.fs.read(path)
  const hosts: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*Host\s+(.+)$/i.exec(line)
    if (!m) continue
    for (const h of m[1]!.split(/\s+/)) {
      if (h && !/[*?!]/.test(h) && !hosts.includes(h)) hosts.push(h)
    }
  }

  return hosts
}

const activeDevice = async ($: EngineInterface) => {
  const id = await read($, active)
  if (!id) return undefined

  return (await read($, devices)).find(d => d.id === id)
}

const showStatus = ($: EngineInterface, d: Device | undefined) => {
  $.ui.status(d ? `裝置：${d.name}` : undefined)
}

const switchTo = async ($: EngineInterface, id: string) => {
  const list = await read($, devices)
  const d = list.find(x => x.id === id)
  await update($, active, () => (d ? d.id : ''))
  await $.store.set(STORE_ACTIVE, d ? d.id : '')
  showStatus($, d)
  await update($, message, () => (d ? `已切換到 ${label(d)}` : '已切換回本機'))
  const note = d
    ? `[device-switcher] The active device is now "${d.name}" (ssh ${d.target}${
        d.port ? ` -p ${d.port}` : ''
      }${d.dir ? `, working folder ${d.dir}` : ''}). Every Bash command you run is executed on that device over ssh automatically${
        d.dir ? ` (starting in ${d.dir})` : ''
      }: write commands as for that machine, using POSIX shell syntax. Local file tools (Read, Write, Edit, Glob, Grep, PowerShell) are disabled while a remote device is active: read and write files through Bash instead (cat, sed -n, tee, heredocs, find, grep). Each Bash call is a fresh ssh session, so cd does not persist between calls; use absolute paths.`
    : '[device-switcher] The active device is back to this local computer. Tools behave normally again; Bash is no longer sent over ssh.'
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
  } catch {
    // No conversation to note it in yet; the deny messages still explain.
  }
}

const saveDevices = async ($: EngineInterface, fn: (list: Device[]) => Device[]) => {
  await update($, devices, fn)
  await $.store.set(STORE_DEVICES, await read($, devices))
}

const addDevice = async ($: EngineInterface, text: string) => {
  const parsed = parseDevice(text)
  if (typeof parsed === 'string') {
    await update($, message, () => parsed)

    return
  }
  await saveDevices($, list => [...list, parsed])
  await update($, message, () => `已加入 ${label(parsed)}`)
}

const testDevice = async ($: EngineInterface, d: Device) => {
  await update($, message, () => `正在測試 ${d.name}…`)
  try {
    const r = await $.process.run(['ssh', ...sshArgs(d), 'echo ok; uname -n'], {
      timeoutMs: 20000,
    })
    const text =
      r.exitCode === 0
        ? `✓ ${d.name} 連線成功：${r.stdout.trim().split(/\r?\n/).pop() ?? ''}`
        : `✗ ${d.name} 連線失敗 (exit ${r.exitCode})：${(r.stderr || r.stdout).trim().slice(0, 300)}`
    await update($, message, () => text)
  } catch (err) {
    await update($, message, () => `✗ ${d.name} 無法執行 ssh：${String(err).slice(0, 300)}`)
  }
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: '裝置切換' })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const stored = await $.store.get(STORE_DEVICES)
    if (Array.isArray(stored)) await update($, devices, () => stored as Device[])
    const storedActive = await $.store.get(STORE_ACTIVE)
    if (typeof storedActive === 'string') await update($, active, () => storedActive)
    try {
      const hosts = await loadSshHosts($)
      await update($, sshHosts, () => hosts)
    } catch {
      // No readable ssh config: nothing to offer.
    }
    showStatus($, await activeDevice($))

    await $.command.register({
      name: 'device',
      description: '開啟裝置切換面板；/device <名稱> 切換，/device local 回本機',
      argumentHint: '[名稱|local]',
    })
    void openPane($)

    return next(e)
  })

  on('command.run', { command: 'device' }, async ($, e) => {
    const arg = e.args.trim()
    if (!arg) {
      await openPane($)

      return { text: '已開啟裝置切換面板。' }
    }
    if (/^(local|本機)$/i.test(arg)) {
      await switchTo($, '')

      return { text: '已切換回本機。' }
    }
    const list = await read($, devices)
    const d = list.find(x => x.name.toLowerCase() === arg.toLowerCase())
    if (!d) return { text: `找不到裝置「${arg}」。已知裝置：${list.map(x => x.name).join(', ') || '（無）'}` }
    await switchTo($, d.id)

    return { text: `已切換到 ${label(d)}。` }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const d = await activeDevice($)
    if (!d) return next(e)
    const remote = cdPart(d.dir) + e.command
    const command = ['ssh', ...sshArgs(d).map(q), q(remote)].join(' ')

    return next({ ...e, command })
  })

  on('tool.call', async ($, e, next) => {
    if (!LOCAL_ONLY_TOOLS.has(e.tool)) return next(e)
    const d = await activeDevice($)
    if (!d) return next(e)
    const input = e as unknown as { file_path?: string; path?: string; notebook_path?: string }
    const path = input.file_path ?? input.notebook_path ?? input.path ?? ''
    if (e.tool !== 'PowerShell' && path && CLAUDE_OWN_PATH.test(path)) return next(e)

    return {
      deny: `目前作用中的裝置是「${d.name}」(${d.target})，本機檔案工具 ${e.tool} 已停用。請改用 Bash：每個 Bash 指令都會自動透過 ssh 在該裝置上執行（例如 cat、sed -n、tee 或 heredoc 寫檔、find、grep）。The active device is remote; use Bash, which runs there over ssh.`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const list = await read($, devices)
    const activeId = await read($, active)
    const msg = await read($, message)
    const hosts = (await read($, sshHosts)).filter(h => !list.some(d => d.target === h))
    const current = list.find(d => d.id === activeId)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>目前讀寫的裝置</Text>
          <Text color={current ? 'success' : undefined}>
            {current ? `● ${label(current)}` : '● 本機（這台電腦）'}
          </Text>
        </Box>

        <Box flexDirection="column">
          <Text bold>切換</Text>
          <Button
            key="local"
            plain
            onPress={() => switchTo($, '')}
          >
            {current ? '○ ' : '● '}本機
          </Button>
          {list.map(d => (
            <Box key={`row-${d.id}`} flexDirection="row" gap={1}>
              <Button key={`use-${d.id}`} plain onPress={() => switchTo($, d.id)}>
                {d.id === activeId ? '● ' : '○ '}
                {d.name} <Text dimColor>{d.target}{d.port ? `:${d.port}` : ''}{d.dir ? ` ${d.dir}` : ''}</Text>
              </Button>
              <Button key={`test-${d.id}`} label="測試" onPress={() => testDevice($, d)} />
              <Button
                key={`del-${d.id}`}
                label="刪除"
                onPress={async () => {
                  if (d.id === activeId) await switchTo($, '')
                  await saveDevices($, l => l.filter(x => x.id !== d.id))
                  await update($, message, () => `已刪除 ${d.name}`)
                }}
              />
            </Box>
          ))}
          {list.length === 0 && <Text dimColor>還沒有遠端裝置，用下面的欄位加入。</Text>}
        </Box>

        <Box flexDirection="column">
          <Text bold>加入裝置</Text>
          <Input
            key="add"
            placeholder="名稱 user@host[:port] [遠端資料夾]"
            submitLabel="加入"
            onSubmit={value => addDevice($, value)}
          />
          {hosts.length > 0 && (
            <Box flexDirection="column">
              <Text dimColor>從 ~/.ssh/config 一鍵加入：</Text>
              {hosts.map(h => (
                <Button key={`ssh-${h}`} plain onPress={async () => {
                    const d: Device = { id: `${h}:${Date.now().toString(36)}`, name: h, target: h }
                    await saveDevices($, l => [...l, d])
                    await update($, message, () => `已加入 ${label(d)}`)
                  }}>
                  + {h}
                </Button>
              ))}
            </Box>
          )}
        </Box>

        {msg !== '' && <Text dimColor>{msg}</Text>}
      </Box>
    )
  })
}
