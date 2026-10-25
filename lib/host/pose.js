/**
 * Pose state machine for the desktop pet.
 *
 * The pet has a small, explicit vocabulary of *poses*:
 *   idle | working | celebrate | slack
 * plus transient *reactions* triggered by direct input:
 *   pet (a click / pat) | drag (dragging the pet)
 *
 * The effective pose is resolved every frame from three inputs, in priority
 * order:
 *   1. a transient reaction (pet / drag) — overrides everything for a moment
 *   2. a manual pose set through `setPose` (panel / API command)
 *   3. the auto target derived from host / activity state
 *
 * The class is pure and side-effect free except for the injected clock, so it
 * is fully unit tested in test/pose.test.js.
 * @module dsh-pet-one/host/pose
 */

/** The four durable poses. */
export const POSES = ['idle', 'working', 'celebrate', 'slack']

/** Transient input reactions (not durable poses). */
export const REACTS = ['pet', 'drag']

/** How long `celebrate` holds before settling back to auto. */
export const DEFAULT_CELEBRATE_MS = 4000

/** Idle for this long (auto mode) before promoting to `slack`. Set 0 to disable. */
export const DEFAULT_SLACK_AFTER_MS = 5 * 60_000

/** Activity phases that count as "the host is working". */
const WORKING_PHASES = new Set(['waiting', 'thinking', 'tool', 'review'])

/**
 * @param {{now?: () => number, celebrateMs?: number, slackAfterMs?: number}} [options]
 */
export class PoseMachine {
  constructor(options = {}) {
    const now = typeof options.now === 'function' ? options.now : Date.now
    this.now = now
    this.celebrateMs = options.celebrateMs ?? DEFAULT_CELEBRATE_MS
    this.slackAfterMs = options.slackAfterMs ?? DEFAULT_SLACK_AFTER_MS
    this.mode = 'auto' // 'auto' | 'manual'
    this.manualPose = null
    this.manualUntil = 0
    this.autoTarget = 'idle'
    this.lastActivityAt = -1
    this.lastCelebrateAt = -1
    this.feedback = null // { kind, until }
  }

  /** Command entry: set a durable pose, or pass 'auto' to resume auto mode. */
  setPose(pose, { ttl = 0 } = {}) {
    if (pose === 'auto') {
      this.mode = 'auto'
      this.manualPose = null
      this.manualUntil = 0
      return this.snapshot()
    }
    if (!POSES.includes(pose)) throw new Error(`unknown-pose:${pose}`)
    const ttlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : 0
    this.mode = 'manual'
    this.manualPose = pose
    this.manualUntil = ttlMs > 0 ? this.now() + ttlMs : 0
    return this.snapshot()
  }

  /** Transient input reaction (click = pet, drag = drag). */
  react(kind) {
    if (!REACTS.includes(kind)) throw new Error(`unknown-react:${kind}`)
    const hold = kind === 'drag' ? 1200 : 600
    this.feedback = { kind, until: this.now() + hold }
    return this.snapshot()
  }

  /** Feed host / activity state; updates the auto target only. */
  syncFromActivity(activity = {}) {
    const phase = activity?.phase ?? 'idle'
    const active = (activity?.activeCount ?? 0) > 0 || WORKING_PHASES.has(phase)
    if (active) {
      this.autoTarget = 'working'
      this.lastActivityAt = this.now()
    } else {
      this.autoTarget = 'idle'
    }
    return this.snapshot()
  }

  /** Signal that a task / turn just completed (celebrate, then settle). */
  celebrate() {
    this.lastCelebrateAt = this.now()
    return this.snapshot()
  }

  /** Advance timers; safe to call every frame. */
  tick() {
    const now = this.now()
    if (this.mode === 'manual' && this.manualUntil !== 0 && now >= this.manualUntil) {
      this.mode = 'auto'
      this.manualPose = null
      this.manualUntil = 0
    }
    if (this.feedback && now >= this.feedback.until) this.feedback = null
    if (
      this.mode === 'auto' &&
      this.autoTarget === 'idle' &&
      this.slackAfterMs > 0 &&
      this.lastActivityAt !== -1 &&
      now - this.lastActivityAt > this.slackAfterMs
    ) {
      this.autoTarget = 'slack'
    }
  }

  /** Resolve the effective display pose plus any reaction. */
  resolve() {
    this.tick()
    if (this.feedback) return { pose: this.feedback.kind, react: this.feedback.kind }
    if (this.mode === 'manual') return { pose: this.manualPose, react: null }
    if (this.lastCelebrateAt >= 0 && this.now() - this.lastCelebrateAt < this.celebrateMs) {
      return { pose: 'celebrate', react: null }
    }
    return { pose: this.autoTarget, react: null }
  }

  /** Serializable snapshot for the API / browser. */
  snapshot() {
    const r = this.resolve()
    return { pose: r.pose, react: r.react, mode: this.mode, autoTarget: this.autoTarget }
  }
}
