/**
 * Session activity projection — turns the durable DSH session event stream
 * into the pet's visual phases. One runtime per session, pure event folding;
 * the tracker below owns the per-session map and the aggregate view.
 *
 * Phases: idle | waiting | thinking | tool | review | done | failed
 * @module dsh-pet-one/host/activity
 */

/** Higher wins when aggregating several live sessions. */
export const PHASE_WEIGHT = {
  failed: 6,
  waiting: 5,
  tool: 4,
  thinking: 3,
  review: 2,
  done: 1,
  idle: 0,
}

/** How long a terminal phase stays on screen before settling to idle. */
export const TERMINAL_HOLD_MS = 8_000
/** A session with no event for this long is considered dormant. */
export const DORMANT_MS = 5 * 60_000

const TOOL_LINE_MAX = 24

/** Clamp a tool name for the status line. */
function shortTool(name) {
  const compact = String(name ?? '工具').replace(/\s+/g, ' ').trim() || '工具'
  return compact.length <= TOOL_LINE_MAX ? compact : `${compact.slice(0, TOOL_LINE_MAX - 3)}...`
}

/** Fresh per-session projection runtime. */
export function emptyRuntime() {
  return { tools: new Set(), failed: false, official: false }
}

/**
 * Project one official session event into a phase input.
 * @param {object} event - SessionEvent with `type` and `data`.
 * @param {object} rt - projection runtime (mutated).
 * @returns {{phase: string, line?: string, turnCompleted?: boolean, tool?: string} | undefined}
 */
export function projectEvent(event, rt) {
  const type = typeof event?.type === 'string' ? event.type : ''
  const data = event?.data ?? {}
  switch (type) {
    case 'turn/start':
      rt.tools.clear()
      rt.failed = false
      return { phase: 'waiting', line: '准备开始' }
    case 'step/start':
      rt.tools.clear()
      rt.failed = false
      return { phase: 'waiting', line: '等待模型响应' }
    case 'assistant/chunk': {
      const chunk = data.chunk ?? {}
      if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
        return { phase: 'thinking', line: '正在思考' }
      }
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
        return { phase: 'review', line: '整理回复中' }
      }
      return undefined
    }
    case 'assistant/message':
      return { phase: 'review', line: '整理回复中' }
    case 'tool/call': {
      const callId = String(data.callId ?? '')
      if (callId !== '') rt.tools.add(callId)
      return { phase: 'tool', line: `正在使用 ${shortTool(data.name)}`, tool: shortTool(data.name) }
    }
    case 'tool/result': {
      const message = data.message ?? {}
      const source = message.source ?? {}
      const callId = String(source.callId ?? '')
      if (callId !== '') rt.tools.delete(callId)
      const block = Array.isArray(message.content) ? message.content[0] : undefined
      if (data.error !== undefined || block?.isError === true) rt.failed = true
      if (rt.tools.size > 0) {
        return { phase: 'tool', line: `还有 ${rt.tools.size} 个工具运行中` }
      }
      return rt.failed
        ? { phase: 'failed', line: '工具执行失败' }
        : { phase: 'thinking', line: '处理工具结果' }
    }
    case 'turn/end': {
      rt.tools.clear()
      const kind = data.reason?.kind ?? 'completed'
      if (kind === 'completed') return { phase: 'done', line: '完成啦', turnCompleted: true }
      if (kind === 'blocked') return { phase: 'waiting', line: '等待继续' }
      if (kind === 'aborted') return { phase: 'idle' }
      if (kind === 'error') return { phase: 'failed', line: '执行失败' }
      if (kind === 'max-tokens') return { phase: 'failed', line: '达到输出上限' }
      if (kind === 'interrupted') return { phase: 'failed', line: '执行意外中断' }
      return { phase: 'idle' }
    }
    case 'activity/status': {
      // Legacy compatibility channel: older harness builds publish this.
      const phase = data.phase
      if (!['idle', 'waiting', 'thinking', 'tool', 'review', 'done', 'failed'].includes(phase)) return undefined
      return { phase, line: typeof data.line === 'string' ? data.line : undefined }
    }
    default:
      return undefined
  }
}

/** Snapshot of a single session's pet-visible state. */
function sessionView(id, entry, now) {
  const held = entry.phase === 'done' || entry.phase === 'failed'
  const phase = held && now - entry.at > TERMINAL_HOLD_MS ? 'idle' : entry.phase
  return {
    id,
    phase,
    line: entry.line ?? '',
    tool: entry.tool ?? null,
    at: entry.at,
    title: entry.title ?? '',
  }
}

/** Tracks every live session and folds them into one display state. */
export class ActivityTracker {
  constructor() {
    this.sessions = new Map()
    this.displayId = null
    this.lastAt = 0
  }

  /** Feed one session event. Returns a completed-turn payload when relevant. */
  onEvent(session, event) {
    const id = String(session?.id ?? session ?? 'unknown')
    const now = Date.now()
    let entry = this.sessions.get(id)
    if (entry === undefined) {
      entry = { phase: 'idle', line: '', tool: null, at: now, runtime: emptyRuntime(), title: titleOf(session) }
      this.sessions.set(id, entry)
    }
    entry.at = now
    entry.title = titleOf(session) || entry.title
    this.displayId = id
    this.lastAt = now
    const input = projectEvent(event, entry.runtime)
    if (input === undefined) return undefined
    if (typeof event?.type === 'string' && event.type !== 'activity/status') entry.runtime.official = true
    entry.phase = input.phase
    entry.line = input.line ?? ''
    entry.tool = input.tool ?? null
    if (input.phase === 'done') entry.runtime.failed = false
    return input.turnCompleted === true ? { sessionId: id, at: now } : undefined
  }

  /** Drop a disposed session. */
  forget(session) {
    const id = String(session?.id ?? session ?? '')
    this.sessions.delete(id)
    if (this.displayId === id) this.displayId = null
  }

  /**
   * Aggregate pet state for the browser.
   * @param {number} now
   */
  view(now = Date.now()) {
    const live = []
    for (const [id, entry] of this.sessions) {
      if (now - entry.at > DORMANT_MS) continue
      live.push(sessionView(id, entry, now))
    }
    live.sort((a, b) => b.at - a.at)
    let chosen = live.find((s) => s.id === this.displayId) ?? null
    if (chosen === null || (chosen.phase === 'idle' && live.length > 0)) {
      chosen = live.reduce((best, s) => {
        if (best === null) return s
        return PHASE_WEIGHT[s.phase] > PHASE_WEIGHT[best.phase] ? s : best
      }, null)
    }
    return {
      phase: chosen?.phase ?? 'idle',
      line: chosen?.line ?? '',
      tool: chosen?.tool ?? null,
      active: live.slice(0, 6),
      activeCount: live.length,
      displaySession: chosen?.id ?? null,
      updatedAt: this.lastAt,
    }
  }
}

/** Read a human session title if the session object exposes one. */
function titleOf(session) {
  const candidate = session?.title ?? session?.meta?.title ?? session?.name
  return typeof candidate === 'string' ? candidate.slice(0, 60) : ''
}
