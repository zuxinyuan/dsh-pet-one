/**
 * Pet service — composes the durable store, the session activity tracker,
 * the affinity economy, the skin registry and the balance reader behind one
 * small facade that the HTTP routes and the optional model tool call.
 * @module dsh-pet-one/host/service
 */

import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { petOneDir } from './home.js'
import { Store, dayKey, defaultState } from './store.js'
import { ActivityTracker } from './activity.js'
import { economyView, interact, rewardTurn } from './economy.js'
import { createSkinRegistry } from './skins.js'
import { createBalanceReader } from './balance.js'
import { readBots, resetBotCache } from './bots.js'
import { resolveDsb, dmChannelFor, sendToBot, createPersonaBot, updatePersonaBot, deletePersonaBot, bindImChannel } from './dsb.js'
import {
  achievementView,
  addMemory,
  checkAchievements,
  levelOf,
  questView,
  rollQuests,
  tickQuest,
  touchDay,
} from './progress.js'

/** Bounds shared with the client sliders. */
export const DISPLAY_BOUNDS = {
  size: [96, 320],
  opacity: [0.25, 1],
  right: [-200, 4000],
  bottom: [-200, 4000],
}

const SAY_TTL_MS = 6_000

/** Coerce one display field within bounds. */
function num(value, [min, max], fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** The plugin's host-side facade. */
export class PetOneService {
  /**
   * @param {{ctx?: object, config?: object, env?: NodeJS.ProcessEnv, dir?: string, store?: Store}} [options]
   */
  constructor(options = {}) {
    this.ctx = options.ctx
    this.config = options.config ?? {}
    this.env = options.env ?? process.env
    this.dir = options.dir ?? petOneDir(this.env)
    this.store = options.store ?? new Store(this.dir)
    this.tracker = new ActivityTracker()
    this.skins = createSkinRegistry({ env: this.env, dir: join(this.dir, 'skins') })
    this.readBalance = createBalanceReader({ env: this.env })
    this.lastBalance = null
    this.botSnapshot = null
    this.lastFiringKey = null
    this.botPulse = null
    this.balanceTimer = null
    this.botsTimer = null
    this.botSnapshot = null
    this.lastFiringKey = null
    this.botPulse = null
    this.botCreatePulse = null
    this.disposers = []
    this.liveTimer = null
    this.liveAt = 0
    this.bridgeTimer = null
    this.pendingChat = null
    this.chatReply = null
    this.lastSessionId = null
    this.sessionTexts = new Map()
  }

  /** Register session listeners (and the optional model tool). */
  attach(ctx = this.ctx) {
    const onEvent = ctx?.on?.('session/event', (session, event) => this.handleSessionEvent(session, event))
    const onDisposed = ctx?.on?.('session/disposed', (session) => this.tracker.forget(session))
    if (typeof onEvent === 'function') this.disposers.push(onEvent)
    if (typeof onDisposed === 'function') this.disposers.push(onDisposed)
    this.registerTool(ctx)
    this.startDesktopBridge()
    this.startBalancePolling()
    this.startBotPolling()
    return () => {
      this.stopDesktopBridge()
      this.stopBalancePolling()
      this.stopBotPolling()
      for (const dispose of this.disposers.splice(0)) {
        try { dispose() } catch { /* ignore */ }
      }
    }
  }

  /**
   * Best-effort `pet_say` tool registration. The definition is a plain
   * registry-shaped object with a real JSON Schema parameter block (the shape
   * `defineTool` would produce), so the plugin keeps zero runtime imports and
   * still works when `@deepseek-ai/dsh-tools` cannot be resolved from a
   * symlinked checkout. No-ops when the tool service is absent.
   */
  registerTool(ctx) {
    const tools = ctx?.get?.('tools')
    if (!tools || typeof tools.register !== 'function') {
      try { ctx?.logger?.info?.('pet-one: tools service absent, pet_say skipped') } catch { /* ignore */ }
      return
    }
    try {
      const dispose = tools.register({
        name: 'pet_say',
        description: "Make the user's desktop pet say one short line in its speech bubble. Use sparingly for celebration, warnings or a friendly status note.",
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The line the pet should say (<=120 chars).' },
          },
          required: ['text'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        execute: async (args) => {
          const text = typeof args?.text === 'string' ? args.text : ''
          const said = this.say(text)
          return said.ok ? `宠物说：${said.say.text}` : '宠物没有听清'
        },
      })
      if (typeof dispose === 'function') this.disposers.push(dispose)
      try { ctx?.logger?.info?.('pet-one: pet_say tool registered') } catch { /* ignore */ }
    } catch (error) {
      try { ctx?.logger?.warn?.('pet-one: pet_say unavailable: ' + String(error)) } catch { /* ignore */ }
    }
  }

  /**
   * Desktop-shell bridge. The macOS pet app cannot pass the `dsh web` auth
   * fence, so the two sides meet on files:
   *   - `live.json`    host -> desktop: the aggregate phase/line snapshot
   *   - `commands.json` desktop -> host: pat/feed/play intents to apply
   * Both files live under `<dshHome>/pet-one/`; the host owns writing live and
   * consuming commands.
   */
  /** Refresh the DeepSeek balance every five minutes when a key exists. */
  startBalancePolling() {
    const tick = () => {
      this.balance().catch(() => {})
    }
    tick()
    this.balanceTimer = setInterval(tick, 5 * 60_000)
    if (typeof this.balanceTimer.unref === 'function') this.balanceTimer.unref()
  }

  stopBalancePolling() {
    if (this.balanceTimer !== null) {
      clearInterval(this.balanceTimer)
      this.balanceTimer = null
    }
  }

  /**
   * Poll the DeepSeekBot roster every few seconds.
   *
   * Read-only and failure-tolerant: DSB may be absent, upgraded, or have its
   * SQLite writer lock held, and none of that may disturb the pet. `readBots`
   * swallows errors and returns `{ ok:false }` instead of throwing.
   */
  startBotPolling() {
    const tick = () => {
      readBots()
        .then((snapshot) => {
          this.botSnapshot = snapshot
          this.detectBotPulse(snapshot)
          this.writeLive()
        })
        .catch(() => {})
    }
    tick()
    this.botsTimer = setInterval(tick, 5_000)
    if (typeof this.botsTimer.unref === 'function') this.botsTimer.unref()
  }

  /**
   * Turn a new schedule firing into a short-lived pulse the desktop can
   * animate (bubble + speech). Keyed by firedAt so one firing fires once.
   */
  detectBotPulse(snapshot) {
    const firing = snapshot?.lastFiring
    if (firing === null || firing === undefined || !firing.firedAt) return
    const key = firing.firedAt
    if (this.lastFiringKey === null) {
      // First observation: remember it without announcing history.
      this.lastFiringKey = key
      return
    }
    if (key === this.lastFiringKey) return
    this.lastFiringKey = key
    const bot = (snapshot.bots ?? []).find((item) => item.slug === firing.bot)
    const title = (snapshot.schedules ?? []).find((item) => item.bot === firing.bot)?.title
    this.botPulse = {
      at: Date.now(),
      bot: bot?.name ?? 'Bot',
      title: title ?? '定时任务',
      skipped: firing.skipped,
      line: firing.skipped ? `${bot?.name ?? 'Bot'} 跳过了「${title ?? '任务'}」` : `${bot?.name ?? 'Bot'} 执行了「${title ?? '定时任务'}」`,
    }
    this.writeLive()
  }

  stopBotPolling() {
    if (this.botsTimer !== null) {
      clearInterval(this.botsTimer)
      this.botsTimer = null
    }
  }

  startDesktopBridge() {
    this.writeLive()
    this.bridgeTimer = setInterval(() => this.drainDesktopCommands(), 1000)
    if (typeof this.bridgeTimer.unref === 'function') this.bridgeTimer.unref()
  }

  /** Stop the desktop bridge timers. */
  stopDesktopBridge() {
    if (this.bridgeTimer !== null) {
      clearInterval(this.bridgeTimer)
      this.bridgeTimer = null
    }
    if (this.liveTimer !== null) {
      clearTimeout(this.liveTimer)
      this.liveTimer = null
    }
  }

  /** Debounced live snapshot write (at most one per 250 ms). */
  scheduleLive() {
    if (this.liveTimer !== null) return
    this.liveTimer = setTimeout(() => {
      this.liveTimer = null
      this.writeLive()
    }, 250)
    if (typeof this.liveTimer.unref === 'function') this.liveTimer.unref()
  }

  /** Write the aggregate state the desktop shell polls. */
  writeLive() {
    try {
      mkdirSync(this.dir, { recursive: true })
      const view = this.view()
      const payload = {
        phase: view.phase,
        line: view.line,
        tool: view.tool,
        activeCount: view.activeCount,
        sessions: view.active.map((item) => ({ id: item.id, phase: item.phase, line: item.line })),
        pet: view.pet,
        ledger: view.ledger,
        quests: view.quests,
        achievements: view.achievements,
        memories: view.memories,
        balance: view.balance,
        chat: view.chat,
        bots: view.bots,
        botPulse: view.botPulse,
        botCreate: view.botCreate,
        botAction: view.botAction,
        imChannels: view.imChannels,
        imBindings: view.imBindings,
        botHistory: view.botHistory,
        botBridge: view.botBridge,
        selectedBotSlug: view.selectedBotSlug,
        updatedAt: Date.now(),
      }
      const target = join(this.dir, 'live.json')
      const tmp = `${target}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(payload) + '\n', 'utf8')
      renameSync(tmp, target)
      this.liveAt = payload.updatedAt
    } catch {
      /* the shell is optional */
    }
  }

  /** Apply queued desktop interactions (one file, appended by the app). */
  drainDesktopCommands() {
    const file = join(this.dir, 'commands.json')
    try {
      if (!existsSync(file)) return
      const raw = readFileSync(file, 'utf8')
      unlinkSync(file)
      const parsed = JSON.parse(raw)
      const commands = Array.isArray(parsed) ? parsed : [parsed]
      for (const command of commands.slice(-20)) {
        const kind = String(command?.kind ?? '')
        if (kind === 'pat' || kind === 'feed' || kind === 'play') this.interaction(kind)
        if (kind === 'pack' && typeof command?.pack === 'string') this.switchPack(command.pack)
        if (kind === 'chat' && typeof command?.text === 'string') {
          const options = {}
          if (command.target === 'bot') options.target = 'bot'
          if (typeof command.botSlug === 'string' && command.botSlug.trim() !== '') {
            options.botSlug = command.botSlug.trim()
          }
          this.chat(command.text, options)
        }
        if (kind === 'create-bot' && typeof command?.displayName === 'string') {
          this.createBot({
            displayName: command.displayName,
            persona: command.persona,
            description: command.description,
            model: command.model,
            preset: command.preset,
          })
        }
        if (kind === 'select-bot') {
          this.selectBot(typeof command.botSlug === 'string' ? command.botSlug : null)
        }
        if (kind === 'update-bot' && typeof command?.botSlug === 'string') {
          this.updateBot({
            botSlug: command.botSlug,
            displayName: command.displayName,
            description: command.description,
            model: command.model,
            preset: command.preset,
            roles: command.roles,
          })
        }
        if (kind === 'delete-bot' && typeof command?.botSlug === 'string') {
          this.deleteBot({
            botSlug: command.botSlug,
            eraseMemory: command.eraseMemory === true,
          })
        }
        if (kind === 'bind-im' && typeof command?.botSlug === 'string') {
          this.bindIm({
            botSlug: command.botSlug,
            kind: command.bindKind ?? command.imKind ?? 'bind',
            providerId: command.providerId,
            accountRef: command.accountRef,
            fingerprint: command.fingerprint,
            id: command.id,
            expectedRevision: command.expectedRevision,
            name: command.name,
            enabled: command.enabled,
            inheritEnabled: command.inheritEnabled,
          })
        }
        if (kind === 'bonus') {
          const state = this.store.get()
          state.pet.treats = Math.min(99, state.pet.treats + 2)
          addMemory(state, '接住了小鱼干，零食 +2')
          this.store.touch()
        }
      }
      this.writeLive()
    } catch {
      /* a malformed queue must not break the pet */
    }
  }

  /** Fold one session event into the tracker + ledger. */
  handleSessionEvent(session, event) {
    try {
      const sessionId = String(session?.id ?? session ?? '')
      if (sessionId !== '' && sessionId !== 'unknown') this.lastSessionId = sessionId
      if (event?.type === 'assistant/message') {
        const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
        const text = blocks.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('')
        if (text !== '') this.sessionTexts.set(sessionId, text)
      }
      const completed = this.tracker.onEvent(session, event)
      const state = this.store.get()
      this.rollLedger(state)
      if (event?.type === 'tool/call') {
        state.ledger.tools += 1
        this.store.touch()
      }
      if (event?.type === 'assistant/message' && event.data?.usage) {
        const usage = event.data.usage
        state.ledger.tokensIn += Math.max(0, Math.floor(Number(usage.inputTokens) || 0))
        state.ledger.tokensOut += Math.max(0, Math.floor(Number(usage.outputTokens) || 0))
        state.ledger.cacheRead += Math.max(0, Math.floor(Number(usage.cacheReadTokens) || 0))
        state.ledger.contextTokens = Math.max(0, Math.floor(Number(usage.totalTokens) || 0))
        state.ledger.calls += 1
        this.store.touch()
      }
      if (completed !== undefined) {
        const beforeLevel = levelOf(state.pet.affinity).level
        state.ledger.turns += 1
        state.life.turns += 1
        touchDay(state)
        const reward = rewardTurn(state.pet, completed.at)
        this.setSay(reward.line, completed.at)
        for (const quest of tickQuest(state, 'turns', completed.at)) {
          addMemory(state, `完成每日任务「${quest.name}」，+${quest.reward} 零食`, completed.at)
        }
        this.announceProgress(state, beforeLevel, completed.at)
        if (this.pendingChat !== null && this.pendingChat.sessionId === sessionId) {
          const reply = (this.sessionTexts.get(sessionId) ?? '').trim().slice(0, 600)
          this.chatReply = { text: reply !== '' ? reply : '（模型没有回复文本）', at: completed.at, sessionId }
          this.pendingChat = null
        }
        this.store.touch()
      }
      this.scheduleLive()
    } catch {
      /* an event we cannot read must never break the session */
    }
  }

  /** Reset daily counters when the local date changes. */
  rollLedger(state = this.store.get()) {
    const today = dayKey()
    if (state.ledger.day !== today) {
      state.ledger = {
        day: today,
        turns: 0,
        tools: 0,
        sessions: 0,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        contextTokens: 0,
        calls: 0,
      }
      this.store.touch()
    }
    return state.ledger
  }

  /** Store a speech-bubble line. */
  setSay(text, at = Date.now()) {
    const trimmed = typeof text === 'string' ? text.trim().slice(0, 200) : ''
    if (trimmed === '') return
    this.store.get().say = { text: trimmed, at }
    this.store.touch()
  }

  /** Public `say` (HTTP + tool share it). */
  say(text) {
    this.setSay(text)
    const say = this.store.get().say
    if (say === null) return { ok: false }
    return { ok: true, say }
  }

  /** Aggregate state payload for the browser. */
  view() {
    const state = this.store.get()
    const ledger = this.rollLedger(state)
    const activity = this.tracker.view()
    const say = state.say
    return {
      ok: true,
      phase: activity.phase,
      line: activity.line,
      tool: activity.tool,
      active: activity.active,
      activeCount: activity.activeCount,
      displaySession: activity.displaySession,
      pet: {
        ...economyView(state.pet),
        level: levelOf(state.pet.affinity),
      },
      display: { ...state.display },
      sound: state.sound,
      quiet: state.quiet,
      skin: state.skin,
      ledger: {
        day: ledger.day,
        turns: ledger.turns,
        tools: ledger.tools,
        costUsd: ledger.costUsd,
        tokensIn: ledger.tokensIn,
        tokensOut: ledger.tokensOut,
        cacheRead: ledger.cacheRead,
        contextTokens: ledger.contextTokens,
        calls: ledger.calls,
        sessionsToday: activity.activeCount,
      },
      quests: questView(state),
      achievements: achievementView(state),
      memories: state.progress.memories.slice(-8).reverse(),
      say: say !== null && Date.now() - say.at < SAY_TTL_MS * 4 ? say : null,
      chat: {
        pending: this.pendingChat?.text ?? null,
        reply: this.chatReply,
      },
      skins: this.skins.list(),
      pageHidden: existsSync(join(this.dir, 'page-hidden')),
      balance: this.lastBalance,
      bots: this.botSnapshot ?? { ok: false, bots: [], schedules: [], dm: null, error: 'pending' },
      botPulse: this.botPulse && Date.now() - this.botPulse.at < 20_000 ? this.botPulse : null,
      botCreate: this.botCreatePulse && Date.now() - this.botCreatePulse.at < 20_000 ? this.botCreatePulse : null,
      botAction: this.botActionPulse && Date.now() - this.botActionPulse.at < 20_000 ? this.botActionPulse : null,
      imChannels: this.botSnapshot?.imChannels ?? [],
      imBindings: this.botSnapshot?.imBindings ?? [],
      botHistory: this.botSnapshot?.history ?? [],
      selectedBotSlug: this.resolveSelectedBotSlug(),
      botBridge: (() => {
        const dsb = resolveDsb(this.ctx)
        if (dsb === null) return { ok: false }
        const slug = this.resolveSelectedBotSlug()
        return { ok: slug !== null, botSlug: slug, dm: slug !== null ? dmChannelFor(dsb, slug) !== null : false }
      })(),
      bounds: DISPLAY_BOUNDS,
      now: Date.now(),
    }
  }

  /** Pet / feed / play. */
  interaction(kind) {
    const state = this.store.get()
    const now = Date.now()
    const beforeLevel = levelOf(state.pet.affinity).level
    const result = interact(state.pet, kind, now, (line) => this.setSay(line))
    if (result.ok) {
      touchDay(state, now)
      if (kind === 'pat') state.life.pats += 1
      if (kind === 'feed') state.life.feeds += 1
      if (kind === 'play') state.life.plays += 1
      for (const quest of tickQuest(state, kind, now)) {
        addMemory(state, `完成每日任务「${quest.name}」，+${quest.reward} 零食`, now)
      }
      this.announceProgress(state, beforeLevel, now)
      this.store.touch()
    }
    this.writeLive()
    return { ...result, pet: economyView(state.pet) }
  }

  /**
   * Send a chat line into the current DSH session through the agent service.
   * Falls back to a spoken error when no live agent owns the session.
   */

  /**
   * Resolve which PersonaBot the panel should talk to.
   * Prefer persisted selection when it still exists in the roster; else DM / first bot.
   */
  resolveSelectedBotSlug() {
    const roster = this.botSnapshot?.bots ?? []
    const slugs = new Set(roster.map((bot) => bot?.slug).filter((s) => typeof s === 'string'))
    const stored = this.store.get().selectedBotSlug
    if (typeof stored === 'string' && (slugs.size === 0 || slugs.has(stored))) return stored
    const dm = this.botSnapshot?.dm?.bot
    if (typeof dm === 'string' && (slugs.size === 0 || slugs.has(dm))) return dm
    const first = roster[0]?.slug
    return typeof first === 'string' ? first : null
  }

  /**
   * Persist panel bot selection in the pet store (not botharness.db).
   * Pass null/empty to clear.
   */
  selectBot(botSlug) {
    const state = this.store.get()
    const next = typeof botSlug === 'string' && botSlug.trim() !== '' ? botSlug.trim().slice(0, 128) : null
    if (state.selectedBotSlug === next) {
      this.writeLive()
      return { ok: true, botSlug: next }
    }
    state.selectedBotSlug = next
    this.store.touch()
    this.writeLive()
    return { ok: true, botSlug: next }
  }

  /**
   * Create a PersonaBot via DSB Cordis API (botharness.creations.create).
   * Never writes botharness.db directly (ADR-013).
   */
  createBot(input = {}) {
    const result = createPersonaBot(this.ctx, input)
    if (result.ok) {
      this.refreshBotsAfterMutation()
      this.selectBot(result.botSlug)
      this.botCreatePulse = {
        at: Date.now(),
        ok: true,
        name: result.displayName,
        botSlug: result.botSlug,
        line: `已创建「${result.displayName}」`,
      }
    } else {
      const hint =
        result.error === 'dsb-unavailable'
          ? 'Bot 模式没开，先启用 DeepSeekBot'
          : `创建失败（${result.error}）`
      this.botCreatePulse = { at: Date.now(), ok: false, error: result.error, line: hint }
      this.chatReply = { text: hint, at: Date.now(), error: true }
    }
    this.writeLive()
    return result
  }

  /** Force-refresh bot roster snapshot after a Cordis mutation. */
  refreshBotsAfterMutation() {
    try { resetBotCache() } catch { /* ignore */ }
    readBots({ force: true })
      .then((snapshot) => {
        this.botSnapshot = snapshot
        this.writeLive()
      })
      .catch(() => {})
  }

  /**
   * Edit a PersonaBot via DSB registry.update (ADR-013).
   */
  updateBot(input = {}) {
    const result = updatePersonaBot(this.ctx, input)
    if (result.ok) {
      this.refreshBotsAfterMutation()
      this.botActionPulse = {
        at: Date.now(),
        ok: true,
        kind: 'update',
        botSlug: result.botSlug,
        name: result.displayName,
        line: `已更新「${result.displayName ?? result.botSlug}」`,
      }
    } else {
      const hint =
        result.error === 'dsb-unavailable'
          ? 'Bot 模式没开，先启用 DeepSeekBot'
          : `更新失败（${result.error}）`
      this.botActionPulse = { at: Date.now(), ok: false, kind: 'update', error: result.error, line: hint }
      this.chatReply = { text: hint, at: Date.now(), error: true }
    }
    this.writeLive()
    return result
  }

  /**
   * Delete a PersonaBot via DSB deletions.preview + confirm (ADR-013).
   * Async; pulse updates when Cordis finishes.
   */
  deleteBot(input = {}) {
    const botSlug = typeof input.botSlug === 'string' ? input.botSlug.trim() : ''
    if (botSlug === '') {
      const result = { ok: false, error: 'empty-slug' }
      this.botActionPulse = { at: Date.now(), ok: false, kind: 'delete', error: 'empty-slug', line: '缺少 botSlug' }
      this.writeLive()
      return result
    }
    this.botActionPulse = {
      at: Date.now(),
      ok: true,
      kind: 'delete',
      pending: true,
      botSlug,
      line: `正在删除「${botSlug}」…`,
    }
    this.writeLive()
    deletePersonaBot(this.ctx, input)
      .then((result) => {
        if (result.ok) {
          if (this.store.get().selectedBotSlug === botSlug) {
            this.selectBot(null)
          }
          this.refreshBotsAfterMutation()
          this.botActionPulse = {
            at: Date.now(),
            ok: true,
            kind: 'delete',
            botSlug,
            name: result.displayName,
            phase: result.phase,
            line: `已删除「${result.displayName ?? botSlug}」`,
          }
        } else {
          const hint =
            result.error === 'dsb-unavailable'
              ? 'Bot 模式没开，先启用 DeepSeekBot'
              : result.error === 'protected-bot'
                ? '受保护的 Bot（如 Tob）不能删'
                : `删除失败（${result.error}）`
          this.botActionPulse = { at: Date.now(), ok: false, kind: 'delete', botSlug, error: result.error, line: hint }
          this.chatReply = { text: hint, at: Date.now(), error: true }
        }
        this.writeLive()
      })
      .catch((error) => {
        this.botActionPulse = {
          at: Date.now(),
          ok: false,
          kind: 'delete',
          botSlug,
          error: String(error?.message ?? error),
          line: `删除失败（${error?.message ?? error}）`,
        }
        this.writeLive()
      })
    return { ok: true, pending: true, botSlug }
  }

  /**
   * Bind / unbind / update IM identity via externalMessaging.identity (ADR-013).
   */
  bindIm(input = {}) {
    const botSlug = typeof input.botSlug === 'string' ? input.botSlug.trim() : ''
    const kind = String(input.kind ?? 'bind')
    if (botSlug === '') {
      const result = { ok: false, error: 'empty-slug' }
      this.botActionPulse = { at: Date.now(), ok: false, kind: 'bind-im', error: 'empty-slug', line: '缺少 botSlug' }
      this.writeLive()
      return result
    }
    this.botActionPulse = {
      at: Date.now(),
      ok: true,
      kind: 'bind-im',
      pending: true,
      botSlug,
      line: kind === 'unbind' ? '正在解绑 IM…' : kind === 'update' ? '正在更新 IM…' : '正在绑定 IM…',
    }
    this.writeLive()
    bindImChannel(this.ctx, input)
      .then((result) => {
        if (result.ok) {
          this.refreshBotsAfterMutation()
          const label =
            kind === 'unbind' ? '已解绑 IM' : kind === 'update' ? '已更新 IM 绑定' : '已绑定 IM 渠道'
          this.botActionPulse = {
            at: Date.now(),
            ok: true,
            kind: 'bind-im',
            botSlug,
            bindKind: kind,
            line: label,
          }
        } else {
          const hint =
            result.error === 'dsb-unavailable'
              ? 'Bot 模式没开，先启用 DeepSeekBot'
              : `IM 操作失败（${result.error}）`
          this.botActionPulse = {
            at: Date.now(),
            ok: false,
            kind: 'bind-im',
            botSlug,
            error: result.error,
            line: hint,
          }
          this.chatReply = { text: hint, at: Date.now(), error: true }
        }
        this.writeLive()
      })
      .catch((error) => {
        this.botActionPulse = {
          at: Date.now(),
          ok: false,
          kind: 'bind-im',
          botSlug,
          error: String(error?.message ?? error),
          line: `IM 操作失败（${error?.message ?? error}）`,
        }
        this.writeLive()
      })
    return { ok: true, pending: true, botSlug, kind }
  }

  chat(text, options = {}) {
    const clean = String(text ?? '').trim().slice(0, 500)
    if (clean === '') return { ok: false, error: 'empty' }

    // Route to a PersonaBot when DSB is present and the caller asked for it.
    // `target: 'bot'` comes from the panel's Bot composer; plain chat keeps
    // using the DSH session (existing behaviour).
    if (options.target === 'bot') {
      const botSlug = (typeof options.botSlug === 'string' && options.botSlug.trim() !== '')
        ? options.botSlug.trim()
        : this.resolveSelectedBotSlug()
      if (typeof botSlug !== 'string') {
        this.chatReply = { text: '还没找到可以说话的 Bot', at: Date.now(), error: true }
        this.writeLive()
        return { ok: false, error: 'no-bot' }
      }
      this.pendingChat = { text: clean, sessionId: `dsb:${botSlug}`, at: Date.now() }
      sendToBot(this.ctx, botSlug, clean)
        .then((result) => {
          if (!result.ok) {
            this.pendingChat = null
            this.chatReply = {
              text: result.error === 'dsb-unavailable' ? 'Bot 模式没开，先启用 DeepSeekBot' : `消息没送到 Bot（${result.error}）`,
              at: Date.now(),
              error: true,
            }
          }
          this.writeLive()
        })
        .catch(() => {})
      this.writeLive()
      return { ok: true, target: 'bot', botSlug }
    }

    const agents = this.ctx?.get?.('agents')
    const sessionId = this.tracker.view().displaySession ?? this.lastSessionId
    let agent = null
    try {
      agent = sessionId !== null ? agents?.get?.(sessionId) : null
    } catch {
      agent = null
    }
    if (!agent || typeof agent.followup !== 'function') {
      this.chatReply = { text: '现在没有活跃会话，先打开一个 DSH 会话再聊吧', at: Date.now(), error: true }
      this.writeLive()
      return { ok: false, error: 'no-session' }
    }
    const message = {
      id: `pet-${Date.now().toString(36)}`,
      role: 'user',
      content: [{ type: 'text', text: clean }],
      source: { kind: 'plugin', plugin: 'dsh-pet-one' },
    }
    try {
      agent.followup(message)
    } catch (error) {
      this.chatReply = { text: '消息没送出去：' + String(error?.message ?? error), at: Date.now(), error: true }
      this.writeLive()
      return { ok: false, error: 'send-failed' }
    }
    this.pendingChat = { text: clean, sessionId, at: Date.now() }
    this.writeLive()
    return { ok: true }
  }

  /** Record a pack switch coming from the desktop shell. */
  switchPack(packId) {
    const state = this.store.get()
    const id = typeof packId === 'string' ? packId.trim().slice(0, 60) : ''
    if (id === '') return { ok: false }
    const beforeLevel = levelOf(state.pet.affinity).level
    if (!state.life.packs.includes(id)) {
      state.life.packs.push(id)
      if (state.life.packs.length > 50) state.life.packs.shift()
      addMemory(state, `换上了新形象「${id}」`)
    }
    this.announceProgress(state, beforeLevel)
    this.store.touch()
    this.writeLive()
    return { ok: true, packs: state.life.packs }
  }

  /** Shared achievement/level-up announcement path. */
  announceProgress(state, beforeLevel, now = Date.now()) {
    const after = levelOf(state.pet.affinity)
    if (after.level > beforeLevel) {
      this.setSay(`${after.icon} 升到 Lv.${after.level}「${after.title}」！`, now)
      addMemory(state, `升到 Lv.${after.level}「${after.title}」`, now)
    }
    for (const unlocked of checkAchievements(state, now)) {
      this.setSay(`🏅 解锁成就「${unlocked.name}」`, now)
    }
  }

  /** Patch display / sound / name / skin. */
  configure(patch = {}) {
    const state = this.store.get()
    const display = state.display
    if ('size' in patch) display.size = num(patch.size, DISPLAY_BOUNDS.size, display.size)
    if ('opacity' in patch) display.opacity = num(patch.opacity, DISPLAY_BOUNDS.opacity, display.opacity)
    if ('right' in patch) display.right = num(patch.right, DISPLAY_BOUNDS.right, display.right)
    if ('bottom' in patch) display.bottom = num(patch.bottom, DISPLAY_BOUNDS.bottom, display.bottom)
    if ('visible' in patch) display.visible = patch.visible !== false
    if ('sound' in patch) state.sound = patch.sound !== false
    if ('quiet' in patch) state.quiet = patch.quiet === true
    if (typeof patch.name === 'string' && patch.name.trim() !== '') {
      state.pet.name = patch.name.trim().slice(0, 24)
    }
    if (typeof patch.skin === 'string' && this.skins.get(patch.skin) !== null) {
      state.skin = patch.skin
    }
    this.store.touch()
    return { ok: true, display: { ...display }, sound: state.sound, quiet: state.quiet, skin: state.skin, pet: economyView(state.pet) }
  }

  /** Show / hide the floating pet. */
  setVisible(visible) {
    this.store.get().display.visible = visible !== false
    this.store.touch()
    return { ok: true, display: { ...this.store.get().display } }
  }

  /** Import a spritesheet atlas and select it. */
  importAtlas(input) {
    const skin = this.skins.importAtlas(input ?? {})
    this.store.get().skin = skin.id
    this.store.touch()
    return { ok: true, skin, skins: this.skins.list() }
  }

  /** Remove an imported atlas. */
  removeAtlas(id) {
    const removed = this.skins.removeAtlas(id)
    const state = this.store.get()
    if (removed && state.skin === id) state.skin = 'whale'
    this.store.touch()
    return { ok: removed, skins: this.skins.list(), skin: state.skin }
  }

  /** Fetch + cache the DeepSeek balance. */
  async balance(force = false) {
    const value = await this.readBalance(force)
    if (value?.ok) this.lastBalance = value
    return value
  }

  /** Flush and release. */
  close() {
    this.stopDesktopBridge()
    this.store.close()
  }
}

export { defaultState }
