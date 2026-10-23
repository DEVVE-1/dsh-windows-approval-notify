/**
 * DSH → Windows 桌面通知。
 *
 * 两种触发：
 *   1. 某个操作正在请求用户授权（approval）。
 *   2. 一轮任务正常结束（turn/end，reason = completed）。
 *
 * 只在 DSH 不是当前前台程序时弹窗：前台窗口标题包含 DSH 的窗口标记（默认
 * “DeepSeek Harness”）时直接跳过，避免盯着界面时被重复打扰。
 * 插件只做转发：不参与授权决策，不改变审批结果，也不做其它任何事情。
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
const TITLE_APPROVAL = 'DSH 需要提权'
const TITLE_TASK_DONE = 'DSH 任务完成'
/** 前台窗口标题里出现这些片段，就认为 DSH 是当前主程序，不弹窗。 */
const ACTIVE_WINDOW_MARKERS = ['DeepSeek Harness']
const MAX_BODY = 220
/** session 事件先于 waterfall 派发，留一点时间让带 displayReason 的请求先到。 */
const WATERFALL_GRACE_MS = 120
const APPROVAL_DEDUPE_MS = 15000
/** 同一会话连续多轮结束时，抑制连发（例如 steer 造成的紧邻两轮）。 */
const COMPLETION_DEDUPE_MS = 3000

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

function normalize(text) {
  return text.trim().replace(/\s+/g, ' ')
}

/** 取 DSH 自己展示给用户的文案：优先本地化 displayReason，其次 reason。 */
function displayText(data) {
  const reason = data?.displayReason
  if (reason && typeof reason === 'object') {
    for (const locale of ['zh', 'zh-CN', 'zh-Hans', 'en']) {
      const text = reason[locale]
      if (typeof text === 'string' && text.trim()) return normalize(text)
    }
    for (const text of Object.values(reason)) {
      if (typeof text === 'string' && text.trim()) return normalize(text)
    }
  }
  if (typeof data?.reason === 'string' && data.reason.trim()) {
    return normalize(data.reason)
  }
  return ''
}

function notifyPayload(kind, body) {
  return {
    title: kind === 'completion' ? TITLE_TASK_DONE : TITLE_APPROVAL,
    body: truncate(body, MAX_BODY),
    tag: kind === 'completion' ? 'dshTaskDone' : 'dshApproval',
    onlyWhenBackground: true,
    activeWindowMarkers: ACTIVE_WINDOW_MARKERS,
  }
}

function formatApproval(data) {
  const tool = typeof data?.toolName === 'string' && data.toolName.trim() ? data.toolName.trim() : ''
  const text = displayText(data)
  const body = text || (tool ? `${tool} 正在请求你的授权` : '有操作正在请求你的授权')
  return notifyPayload('approval', body)
}

function formatCompletion(session, titleOf) {
  const title = titleOf(session)
  return notifyPayload('completion', title ? `「${title}」已完成` : '当前会话的这一轮任务已完成')
}

function approvalKey(data) {
  if (typeof data?.callId === 'string' && data.callId) return data.callId
  return `${data?.toolName ?? ''}|${data?.reason ?? ''}`
}

/** 子代理会话不属于“任务完成”通知的范围。 */
function isRootSession(session) {
  const header = session?.header
  if (!header) return false
  if (header.origin === 'subagent') return false
  return !header.parentSession
}

export function apply(ctx, config) {
  if (process.platform !== 'win32') return

  const logger = typeof ctx.logger === 'function' ? ctx.logger('approval-notify') : undefined
  const channel = createToastChannel(logger)
  const recent = new Map()
  const timers = new Set()

  function readSessionTitle(session) {
    try {
      const titles = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : ctx.sessionTitle
      const snapshot = titles?.get?.(session)
      const title = typeof snapshot?.title === 'string' ? normalize(snapshot.title) : ''
      return title
    } catch {
      return ''
    }
  }

  function mark(key) {
    const now = Date.now()
    recent.set(key, now)
    if (recent.size > 64) {
      for (const [k, time] of recent) {
        if (now - time > APPROVAL_DEDUPE_MS) recent.delete(k)
      }
    }
  }

  function seen(key, ttl = APPROVAL_DEDUPE_MS) {
    const time = recent.get(key)
    return time !== undefined && Date.now() - time < ttl
  }

  function announceApproval(key, data) {
    if (seen(key)) return
    mark(key)
    channel.show(formatApproval(data))
  }

  function announceCompletion(session) {
    const key = `turn-end:${session.id}`
    if (seen(key, COMPLETION_DEDUPE_MS)) return
    mark(key)
    channel.show(formatCompletion(session, readSessionTitle))
  }

  ctx.effect(() => {
    // 插件激活即预热 PowerShell 通知宿主，之后弹窗只需 5–10ms。
    channel.start()

    // 主路径：approval/request 携带 DSH 展示给用户的 displayReason。
    // prepend 保证先于任何 answerer 执行，这样内容不会被别人抢先认领掉。
    const offRequest = ctx.on(
      'approval/request',
      (req, next) => {
        announceApproval(approvalKey(req), req)
        return next()
      },
      true,
    )

    const offEvent = ctx.on('session/event', (session, event) => {
      if (!event) return

      // 一轮任务正常结束（aborted / error / blocked 不提示）。
      if (event.type === 'turn/end') {
        if (event.data?.reason?.kind !== 'completed') return
        if (!isRootSession(session)) return
        announceCompletion(session)
        return
      }

      // 兜底：approval/request 被其它 answerer 抢先认领时，改由已落库的 approval/asked 触发。
      if (event.type !== 'approval/asked') return
      const key = approvalKey(event.data)
      if (seen(key)) return
      const timer = setTimeout(() => {
        timers.delete(timer)
        announceApproval(key, event.data)
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

/** 纯函数出口：只用于离线自检，不参与运行时行为。 */
export const __test = { displayText, formatApproval, formatCompletion, isRootSession, approvalKey }
