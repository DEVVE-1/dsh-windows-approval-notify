/**
 * DSH → Windows 提权通知。
 *
 * 唯一的职责：当某个操作正在请求用户授权时，立刻弹出一条 Windows 通知，
 * 内容沿用 DSH 自己的提示文案（displayReason，其次 reason）。不参与、不影响授权结果。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'notify-host.ps1')
const POWERSHELL = 'powershell.exe'
const PS_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-WindowStyle',
  'Hidden',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  HELPER,
]
const TITLE = 'DSH 需要提权'
const MAX_BODY = 220
/** session 事件先于 waterfall 派发，留一点时间让带 displayReason 的请求先到。 */
const WATERFALL_GRACE_MS = 120
const DEDUPE_MS = 15000

/**
 * 常驻通知通道：启动一次 PowerShell，之后每次通知只写一行 JSON（实测 5–10ms 出弹窗）。
 * 进程意外退出时退化为一次性弹窗并退避重启。
 */
function createToastChannel(logger) {
  let child = null
  let ready = false
  let buffer = ''
  let pending = null
  let restartDelay = 2000
  let restartTimer = null
  let disposed = false

  function start() {
    if (disposed || child) return
    let proc
    try {
      proc = spawn(POWERSHELL, PS_ARGS, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    } catch (error) {
      logger?.warn?.('approval-notify: cannot spawn powershell', error)
      scheduleRestart()
      return
    }
    child = proc
    ready = false
    buffer = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', onData)
    proc.stdin.on('error', () => {})
    proc.on('error', () => fail(proc))
    proc.on('exit', () => fail(proc))
  }

  function onData(chunk) {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line === 'ready') {
        ready = true
        restartDelay = 2000
        flush()
      }
    }
  }

  function flush() {
    if (!ready || !child || !pending) return
    const payload = pending
    pending = null
    try {
      child.stdin.write(JSON.stringify(payload) + '\n')
    } catch (error) {
      pending = payload
      logger?.warn?.('approval-notify: write failed', error)
    }
  }

  function flushOnce() {
    const payload = pending
    pending = null
    if (!payload || disposed) return
    try {
      const proc = spawn(POWERSHELL, PS_ARGS, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
      proc.stdin.on('error', () => {})
      proc.stdin.end(JSON.stringify(payload) + '\n')
      proc.on('error', () => {})
    } catch (error) {
      logger?.warn?.('approval-notify: fallback spawn failed', error)
    }
  }

  function fail(proc) {
    if (proc !== child) return
    child = null
    ready = false
    buffer = ''
    if (pending) flushOnce()
    scheduleRestart()
  }

  function scheduleRestart() {
    if (disposed || restartTimer) return
    restartTimer = setTimeout(() => {
      restartTimer = null
      start()
    }, restartDelay)
    restartTimer.unref?.()
    restartDelay = Math.min(restartDelay * 2, 30000)
  }

  function show(payload) {
    if (disposed) return
    pending = payload
    if (ready) flush()
    else if (!child) {
      start()
      if (!child) flushOnce()
    }
  }

  function dispose() {
    disposed = true
    pending = null
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    if (child) {
      try {
        child.kill()
      } catch {}
      child = null
    }
    ready = false
  }

  return { start, show, dispose }
}

function truncate(text, limit) {
  if (text.length <= limit) return text
  return text.slice(0, limit - 1) + '…'
}

/** 取 DSH 自己展示给用户的文案：优先本地化 displayReason，其次 reason。 */
function displayText(data) {
  const reason = data?.displayReason
  if (reason && typeof reason === 'object') {
    for (const locale of ['zh', 'zh-CN', 'zh-Hans', 'en']) {
      const text = reason[locale]
      if (typeof text === 'string' && text.trim()) return text.trim().replace(/\s+/g, ' ')
    }
    for (const text of Object.values(reason)) {
      if (typeof text === 'string' && text.trim()) return text.trim().replace(/\s+/g, ' ')
    }
  }
  if (typeof data?.reason === 'string' && data.reason.trim()) {
    return data.reason.trim().replace(/\s+/g, ' ')
  }
  return ''
}

function formatApproval(data) {
  const tool = typeof data?.toolName === 'string' && data.toolName.trim() ? data.toolName.trim() : ''
  const text = displayText(data)
  const body = text || (tool ? `${tool} 正在请求你的授权` : '有操作正在请求你的授权')
  return { title: TITLE, body: truncate(body, MAX_BODY) }
}

function keyOf(data) {
  if (typeof data?.callId === 'string' && data.callId) return data.callId
  return `${data?.toolName ?? ''}|${data?.reason ?? ''}`
}

export function apply(ctx, config) {
  if (process.platform !== 'win32') return

  const logger = typeof ctx.logger === 'function' ? ctx.logger('approval-notify') : undefined
  const channel = createToastChannel(logger)
  const recent = new Map()
  const timers = new Set()

  function mark(key) {
    const now = Date.now()
    recent.set(key, now)
    if (recent.size > 64) {
      for (const [k, time] of recent) {
        if (now - time > DEDUPE_MS) recent.delete(k)
      }
    }
  }

  function seen(key) {
    const time = recent.get(key)
    return time !== undefined && Date.now() - time < DEDUPE_MS
  }

  function announce(key, data) {
    if (seen(key)) return
    mark(key)
    channel.show(formatApproval(data))
  }

  ctx.effect(() => {
    // 插件激活即预热 PowerShell 通知宿主，之后弹窗只需 5–10ms。
    channel.start()

    // 主路径：approval/request 携带 DSH 展示给用户的 displayReason。
    // prepend 保证先于任何 answerer 执行，这样内容不会被别人抢先认领掉。
    const offRequest = ctx.on(
      'approval/request',
      (req, next) => {
        announce(keyOf(req), req)
        return next()
      },
      true,
    )

    // 兜底：approval/request 被其它 answerer 抢先认领时，改由已落库的 approval/asked 触发。
    const offEvent = ctx.on('session/event', (session, event) => {
      if (!event || event.type !== 'approval/asked') return
      const key = keyOf(event.data)
      if (seen(key)) return
      const timer = setTimeout(() => {
        timers.delete(timer)
        announce(key, event.data)
      }, WATERFALL_GRACE_MS)
      timer.unref?.()
      timers.add(timer)
    })

    return () => {
      offRequest()
      offEvent()
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      channel.dispose()
    }
  })

  void config
}
