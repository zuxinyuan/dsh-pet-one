/**
 * Pet service — composes the durable store, the session activity tracker,
 * the affinity economy, the skin registry and the balance reader behind one
 * small facade that the HTTP routes and the optional model tool call.
 * @module dsh-pet-one/host/service
 */

import { join, dirname } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { petOneDir } from './home.js'
import { Store, dayKey, defaultState } from './store.js'
import { ActivityTracker } from './activity.js'
import { economyView, interact, rewardTurn } from './economy.js'
import { createSkinRegistry } from './skins.js'
import { createBalanceReader } from './balance.js'
import { readBots, resetBotCache } from './bots.js'
import { resolveDsb, dmChannelFor, sendToBot, createPersonaBot, updatePersonaBot, deletePersonaBot, bindImChannel, resolveMeetingsSource, readMeetings, meetingAction } from './dsb.js'
import { loadQuestGuide, DEFAULT_CARD, normalizeCard } from './quest-guide.js'
import { normalizeArtPage, normalizeArtPages, renderArtPageHtml, seedArtPage } from './art.js'
import { normalizeFeedPost, normalizeFeedPosts, seedFeedPost } from './feed.js'
import { normalizeFeedSourceConfig, fetchAllSources } from './feed-sources.js'
import { normalizeGoal, normalizeGoals, seedGoals } from './goals.js'
import { normalizeIdea, normalizeIdeas, seedIdeas } from './ideas.js'
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

/** 会议动作的人类可读标签（脉冲行用）。 */
function meetingActionLabel(action) {
  if (action === 'join') return '加入会议'
  if (action === 'open') return '打开会议链接'
  if (action === 'message') return '会中发消息'
  return '会议操作'
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
    // 任务指引目录：默认指向仓库内的 quest-guide/（soulmate 把任务卡丢这里）。
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    this.questGuideDir = options.questGuideDir ?? join(repoRoot, 'quest-guide')
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
    this.meetingsSnapshot = { ok: false, reason: 'pending', meetings: [] }
    this.meetingPulse = null
    this.meetingsTimer = null
    this.disposers = []
    this.liveTimer = null
    this.liveAt = 0
    this.bridgeTimer = null
    this.pendingChat = null
    this.chatReply = null
    this.lastSessionId = null
    this.sessionTexts = new Map()
    // Art board: first run shows the Day 8 example the user shared,
    // so the new tab is never empty. Later pages are user-created.
    if (!Array.isArray(this.store.get().artPages) || this.store.get().artPages.length === 0) {
      this.store.get().artPages = [seedArtPage()]
      this.store.get().selectedArtId = '2026-10-17'
      this.store.touch()
    }
    this.artPulse = null
    // Muse-like tabs: first run seeds are labelled, never fake user content.
    if (!Array.isArray(this.store.get().feedPosts) || this.store.get().feedPosts.length === 0) {
      this.store.get().feedPosts = [seedFeedPost()]
      this.store.touch()
    }
    if (!Array.isArray(this.store.get().ideas) || this.store.get().ideas.length === 0) {
      this.store.get().ideas = seedIdeas()
      this.store.get().selectedIdeaId = 'idea-art-auto'
      this.store.touch()
    }
    if (!Array.isArray(this.store.get().goals) || this.store.get().goals.length === 0) {
      this.store.get().goals = seedGoals()
      this.store.get().selectedGoalId = 'goal-example'
      this.store.touch()
    }
    this.feedPulse = null
    this.ideaPulse = null
    this.goalPulse = null
    this.feedSourcesTimer = null
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
    this.startMeetingsPolling()
    this.startFeedPolling()
    return () => {
      this.stopDesktopBridge()
      this.stopBalancePolling()
      this.stopBotPolling()
      this.stopMeetingsPolling()
      this.stopFeedPolling()
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

  /**
   * Poll DSB 的日历源，刷新今日 / 即将开始的会议列表。
   * 只读、失败容忍：DSB 未开日历或日历能力不存在时返回 `{ok:false}`，不抛。
   */
  startMeetingsPolling() {
    const tick = () => {
      readMeetings(this.ctx)
        .then((snapshot) => {
          this.meetingsSnapshot = snapshot
          this.writeLive()
        })
        .catch(() => {})
    }
    tick()
    this.meetingsTimer = setInterval(tick, 15_000)
    if (typeof this.meetingsTimer.unref === 'function') this.meetingsTimer.unref()
  }

  stopMeetingsPolling() {
    if (this.meetingsTimer !== null) {
      clearInterval(this.meetingsTimer)
      this.meetingsTimer = null
    }
  }

  /**
   * Periodically pull X + YouTube content. Reads the saved `feedSources`
   * config; when `refreshMinutes` is 0 (the default) no timer runs and the
   * panel relies on the manual 刷新 button. Never throws — a failed refresh
   * only updates `feedStatus.errors`.
   */
  startFeedPolling() {
    this.stopFeedPolling()
    const minutes = this.store.get().feedSources.refreshMinutes
    if (!minutes || minutes <= 0) return
    const tick = () => {
      this.refreshFeedSources().catch(() => {})
    }
    this.feedSourcesTimer = setInterval(tick, Math.max(1, minutes) * 60_000)
    if (typeof this.feedSourcesTimer.unref === 'function') this.feedSourcesTimer.unref()
  }

  stopFeedPolling() {
    if (this.feedSourcesTimer !== null) {
      clearInterval(this.feedSourcesTimer)
      this.feedSourcesTimer = null
    }
  }

  /** Persist the X / YouTube source config and (re)start the polling timer. */
  configureFeedSources(patch = {}) {
    const current = this.store.get().feedSources
    const next = normalizeFeedSourceConfig({
      x: { ...current.x, ...(patch.x && typeof patch.x === 'object' ? patch.x : {}) },
      youtube: { ...current.youtube, ...(patch.youtube && typeof patch.youtube === 'object' ? patch.youtube : {}) },
      refreshMinutes: patch.refreshMinutes ?? current.refreshMinutes,
    })
    this.store.get().feedSources = next
    this.store.touch()
    this.startFeedPolling()
    this.writeLive()
    return { ok: true, sources: next }
  }

  /**
   * Pull every enabled source and merge the posts into the feed. Source posts
   * are upserted by id (stable `x:<id>` / `youtube:<id>`), so re-running refresh
   * never duplicates and never drops manual posts. Fail-soft: per-source errors
   * land in `feedStatus.errors` and the panel shows one honest line.
   * @param {{fetchImpl?: Function, xRssBase?: string}} [opts]
   */
  async refreshFeedSources(opts = {}) {
    const config = this.store.get().feedSources
    let result
    try {
      result = await fetchAllSources(config, {
        fetchImpl: opts.fetchImpl,
        xRssBase: opts.xRssBase ?? this.env.FEED_X_RSS_BASE,
      })
    } catch {
      result = { ok: false, posts: [], errors: [{ source: 'feed', reason: 'unexpected' }] }
    }
    const state = this.store.get()
    const byId = new Map(normalizeFeedPosts(state.feedPosts).map((post) => [post.id, post]))
    for (const post of result.posts) byId.set(post.id, post)
    state.feedPosts = normalizeFeedPosts([...byId.values()])
    state.feedStatus = {
      ok: result.errors.length === 0,
      lastRefreshAt: Date.now(),
      fetched: result.posts.length,
      errors: result.errors,
    }
    const ok = result.errors.length === 0
    this.feedPulse = {
      at: Date.now(),
      ok,
      id: 'refresh',
      line: ok
        ? `已刷新 ${result.posts.length} 条动态`
        : `已刷新，但有 ${result.errors.length} 个来源失败`,
    }
    this.store.touch()
    this.writeLive()
    return { ok: true, fetched: result.posts.length, errors: result.errors, lastRefreshAt: state.feedStatus.lastRefreshAt }
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
        questGuide: view.questGuide,
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
        meetings: view.meetings,
        meetingPulse: view.meetingPulse,
        botBridge: view.botBridge,
        selectedBotSlug: view.selectedBotSlug,
        art: view.art,
        artPulse: view.artPulse,
        selectedArtId: view.selectedArtId,
        feed: view.feed,
        feedSources: view.feedSources,
        feedStatus: view.feedStatus,
        feedPulse: view.feedPulse,
        ideas: view.ideas,
        ideaPulse: view.ideaPulse,
        selectedIdeaId: view.selectedIdeaId,
        goals: view.goals,
        goalPulse: view.goalPulse,
        selectedGoalId: view.selectedGoalId,
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
        if (kind === 'create-art') {
          this.createArtPage({
            date: command.date,
            day: command.day,
            title: command.title,
            insight: command.insight,
            caption: command.caption,
            illustration: command.illustration,
          })
        }
        if (kind === 'select-art') {
          this.selectArt(typeof command.artId === 'string' ? command.artId : null)
        }
        if (kind === 'delete-art' && typeof command?.artId === 'string') {
          this.deleteArtPage(command.artId)
        }
        if (kind === 'create-feed') {
          this.createFeedPost({ text: command.text, source: command.source })
        }
        if (kind === 'delete-feed' && typeof command?.feedId === 'string') {
          this.deleteFeedPost(command.feedId)
        }
        if (kind === 'refresh-feed') {
          this.refreshFeedSources().catch(() => {})
        }
        if (kind === 'create-idea') {
          this.createIdea({ title: command.title, detail: command.detail })
        }
        if (kind === 'select-idea') {
          this.selectIdea(typeof command.ideaId === 'string' ? command.ideaId : null)
        }
        if (kind === 'update-idea' && typeof command?.ideaId === 'string') {
          this.updateIdea({ id: command.ideaId, status: command.status, title: command.title, detail: command.detail })
        }
        if (kind === 'delete-idea' && typeof command?.ideaId === 'string') {
          this.deleteIdea(command.ideaId)
        }
        if (kind === 'create-goal') {
          this.createGoal({ title: command.title, detail: command.detail, targetDate: command.targetDate, progress: command.progress })
        }
        if (kind === 'select-goal') {
          this.selectGoal(typeof command.goalId === 'string' ? command.goalId : null)
        }
        if (kind === 'update-goal' && typeof command?.goalId === 'string') {
          this.updateGoal({ id: command.goalId, status: command.status, title: command.title, detail: command.detail, targetDate: command.targetDate, progress: command.progress })
        }
        if (kind === 'delete-goal' && typeof command?.goalId === 'string') {
          this.deleteGoal(command.goalId)
        }
        if (kind === 'meeting' && typeof command?.action === 'string' && typeof command?.meetingId === 'string') {
          this.meetingAction({
            action: command.action,
            meetingId: command.meetingId,
            text: command.text,
            joinUrl: command.joinUrl,
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
      questGuide: this.questGuide(),
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
      meetings: this.meetingsSnapshot ?? { ok: false, reason: 'pending', meetings: [] },
      meetingPulse: this.meetingPulse && Date.now() - this.meetingPulse.at < 20_000 ? this.meetingPulse : null,
      selectedBotSlug: this.resolveSelectedBotSlug(),
      art: { ok: true, pages: normalizeArtPages(state.artPages) },
      artPulse: this.artPulse && Date.now() - this.artPulse.at < 20_000 ? this.artPulse : null,
      selectedArtId: this.resolveSelectedArtId(),
      feed: { ok: true, posts: normalizeFeedPosts(state.feedPosts) },
      feedSources: state.feedSources,
      feedStatus: state.feedStatus,
      feedPulse: this.feedPulse && Date.now() - this.feedPulse.at < 20_000 ? this.feedPulse : null,
      ideas: { ok: true, items: normalizeIdeas(state.ideas) },
      ideaPulse: this.ideaPulse && Date.now() - this.ideaPulse.at < 20_000 ? this.ideaPulse : null,
      selectedIdeaId: this.resolveSelectedIdeaId(),
      goals: { ok: true, items: normalizeGoals(state.goals) },
      goalPulse: this.goalPulse && Date.now() - this.goalPulse.at < 20_000 ? this.goalPulse : null,
      selectedGoalId: this.resolveSelectedGoalId(),
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

  /** 探测 DSB 是否提供了日历能力（供面板判断空态）。 */
  resolveMeetingsSource() {
    return resolveMeetingsSource(this.ctx)
  }

  /**
   * 对单场会议执行动作（加入 / 打开链接 / 会中发消息）。
   * 经 Cordis `botharness` 的 calendar 能力；DSB 没开日历时降级提示（ADR-011/013）。
   */
  async meetingAction(input = {}) {
    const action = String(input.action ?? '')
    const meetingId = String(input.meetingId ?? '').trim()
    if (meetingId === '' && action !== '') {
      this.meetingPulse = { at: Date.now(), ok: false, action, line: '缺少会议 ID' }
      this.writeLive()
      return { ok: false, error: 'empty-meeting-id' }
    }
    if (this.resolveMeetingsSource() === null) {
      const line = 'DSB 还没开日历，先去 DeepSeek Harness 连上日历再回来看'
      this.meetingPulse = { at: Date.now(), ok: false, action, meetingId, line }
      this.chatReply = { text: line, at: Date.now(), error: true }
      this.writeLive()
      return { ok: false, error: 'calendar-source-unavailable' }
    }
    this.meetingPulse = { at: Date.now(), ok: true, action, pending: true, meetingId, line: meetingActionLabel(action) + '…' }
    this.writeLive()
    try {
      const result = await meetingAction(this.ctx, input)
      if (result.ok) {
        const line = action === 'open'
          ? (result.joinUrl ? '已打开会议链接' : '这场会议没有可打开的链接')
          : `${meetingActionLabel(action)}成功`
        this.meetingPulse = {
          at: Date.now(),
          ok: true,
          action,
          meetingId,
          line,
          joinUrl: result.joinUrl ?? null,
        }
      } else {
        const hint =
          result.reason === 'calendar-source-unavailable'
            ? 'DSB 还没开日历，先去连上日历'
            : result.reason === 'action-unsupported'
              ? '这个日历不支持该操作'
              : `会议操作失败（${result.reason}）`
        this.meetingPulse = { at: Date.now(), ok: false, action, meetingId, line: hint }
        this.chatReply = { text: hint, at: Date.now(), error: true }
      }
    } catch (error) {
      this.meetingPulse = {
        at: Date.now(),
        ok: false,
        action,
        meetingId,
        line: `会议操作失败（${error?.message ?? error}）`,
      }
    }
    this.writeLive()
    return { ok: true, pending: true, action, meetingId }
  }

  /** Art board: resolve the selected daily-review page id. */
  resolveSelectedArtId() {
    const pages = normalizeArtPages(this.store.get().artPages)
    const stored = this.store.get().selectedArtId
    if (typeof stored === 'string' && pages.some((page) => page.id === stored)) return stored
    return pages[0]?.id ?? null
  }

  /** Art board: create (or replace, by date) one daily-review page. */
  createArtPage(input = {}) {
    const page = normalizeArtPage(input)
    if (page === null) return { ok: false, error: 'invalid-art-page' }
    const state = this.store.get()
    const pages = normalizeArtPages(state.artPages).filter((item) => item.id !== page.id)
    pages.unshift(page)
    state.artPages = normalizeArtPages(pages)
    state.selectedArtId = page.id
    this.artPulse = { at: Date.now(), ok: true, id: page.id, line: `已保存每日回顾「${page.title.replace(/\n/g, ' ')}」` }
    this.store.touch()
    this.writeLive()
    return { ok: true, page, html: renderArtPageHtml(page) }
  }

  /** Art board: select one page for the panel detail view. */
  selectArt(id) {
    const pages = normalizeArtPages(this.store.get().artPages)
    const next = typeof id === 'string' && pages.some((page) => page.id === id) ? id : null
    this.store.get().selectedArtId = next
    this.store.touch()
    this.writeLive()
    return { ok: true, id: next }
  }

  /** Art board: delete one page; selection falls back to the newest remaining page. */
  deleteArtPage(id) {
    const state = this.store.get()
    const before = normalizeArtPages(state.artPages).length
    state.artPages = normalizeArtPages(state.artPages).filter((page) => page.id !== id)
    if (state.selectedArtId === id) state.selectedArtId = state.artPages[0]?.id ?? null
    this.artPulse = { at: Date.now(), ok: true, id, line: '已删除该页每日回顾' }
    this.store.touch()
    this.writeLive()
    return { ok: before - state.artPages.length > 0, deleted: before - state.artPages.length }
  }

  /** Feed: create one post (newest first). */
  createFeedPost(input = {}) {
    const post = normalizeFeedPost({ ...input, id: input.id ?? `feed-${Date.now()}`, createdAt: input.createdAt ?? Date.now() })
    if (post === null) return { ok: false, error: 'invalid-feed-post' }
    const state = this.store.get()
    state.feedPosts = normalizeFeedPosts([post, ...normalizeFeedPosts(state.feedPosts)])
    this.feedPulse = { at: Date.now(), ok: true, id: post.id, line: '已保存一条动态' }
    this.store.touch()
    this.writeLive()
    return { ok: true, post }
  }

  /** Feed: delete one post. */
  deleteFeedPost(id) {
    const state = this.store.get()
    const before = normalizeFeedPosts(state.feedPosts).length
    state.feedPosts = normalizeFeedPosts(state.feedPosts).filter((post) => post.id !== id)
    this.feedPulse = { at: Date.now(), ok: true, id, line: '已删除该条动态' }
    this.store.touch()
    this.writeLive()
    return { ok: before - state.feedPosts.length > 0, deleted: before - state.feedPosts.length }
  }

  /** Ideas: resolve the selected idea id. */
  resolveSelectedIdeaId() {
    const items = normalizeIdeas(this.store.get().ideas)
    const stored = this.store.get().selectedIdeaId
    if (typeof stored === 'string' && items.some((item) => item.id === stored)) return stored
    return items[0]?.id ?? null
  }

  /** Ideas: create one card. */
  createIdea(input = {}) {
    const idea = normalizeIdea({ ...input, id: input.id ?? `idea-${Date.now()}`, createdAt: input.createdAt ?? Date.now() })
    if (idea === null) return { ok: false, error: 'invalid-idea' }
    const state = this.store.get()
    state.ideas = normalizeIdeas([idea, ...normalizeIdeas(state.ideas)])
    state.selectedIdeaId = idea.id
    this.ideaPulse = { at: Date.now(), ok: true, id: idea.id, line: `已保存点子「${idea.title}」` }
    this.store.touch()
    this.writeLive()
    return { ok: true, idea }
  }

  /** Ideas: select one card for the panel detail view. */
  selectIdea(id) {
    const items = normalizeIdeas(this.store.get().ideas)
    const next = typeof id === 'string' && items.some((item) => item.id === id) ? id : null
    this.store.get().selectedIdeaId = next
    this.store.touch()
    this.writeLive()
    return { ok: true, id: next }
  }

  /** Ideas: update title/detail/status of one card. */
  updateIdea(input = {}) {
    const state = this.store.get()
    const items = normalizeIdeas(state.ideas)
    const index = items.findIndex((item) => item.id === input.id)
    if (index < 0) return { ok: false, error: 'idea-not-found' }
    const overrides = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
    const updated = normalizeIdea({ ...items[index], ...overrides, id: items[index].id, createdAt: items[index].createdAt })
    if (updated === null) return { ok: false, error: 'invalid-idea' }
    items[index] = updated
    state.ideas = normalizeIdeas(items)
    this.ideaPulse = { at: Date.now(), ok: true, id: updated.id, line: `已更新点子「${updated.title}」` }
    this.store.touch()
    this.writeLive()
    return { ok: true, idea: updated }
  }

  /** Ideas: delete one card; selection falls back to the newest remaining card. */
  deleteIdea(id) {
    const state = this.store.get()
    const before = normalizeIdeas(state.ideas).length
    state.ideas = normalizeIdeas(state.ideas).filter((item) => item.id !== id)
    if (state.selectedIdeaId === id) state.selectedIdeaId = state.ideas[0]?.id ?? null
    this.ideaPulse = { at: Date.now(), ok: true, id, line: '已删除该点子' }
    this.store.touch()
    this.writeLive()
    return { ok: before - state.ideas.length > 0, deleted: before - state.ideas.length }
  }

  /** Goals: resolve the selected goal id. */
  resolveSelectedGoalId() {
    const items = normalizeGoals(this.store.get().goals)
    const stored = this.store.get().selectedGoalId
    if (typeof stored === 'string' && items.some((item) => item.id === stored)) return stored
    return items[0]?.id ?? null
  }

  /** Goals: create one goal. */
  createGoal(input = {}) {
    const goal = normalizeGoal({ ...input, id: input.id ?? `goal-${Date.now()}`, createdAt: input.createdAt ?? Date.now() })
    if (goal === null) return { ok: false, error: 'invalid-goal' }
    const state = this.store.get()
    state.goals = normalizeGoals([goal, ...normalizeGoals(state.goals)])
    state.selectedGoalId = goal.id
    this.goalPulse = { at: Date.now(), ok: true, id: goal.id, line: `已保存目标「${goal.title}」` }
    this.store.touch()
    this.writeLive()
    return { ok: true, goal }
  }

  /** Goals: select one goal for the panel detail view. */
  selectGoal(id) {
    const items = normalizeGoals(this.store.get().goals)
    const next = typeof id === 'string' && items.some((item) => item.id === id) ? id : null
    this.store.get().selectedGoalId = next
    this.store.touch()
    this.writeLive()
    return { ok: true, id: next }
  }

  /** Goals: update title/detail/targetDate/progress/status of one goal. */
  updateGoal(input = {}) {
    const state = this.store.get()
    const items = normalizeGoals(state.goals)
    const index = items.findIndex((item) => item.id === input.id)
    if (index < 0) return { ok: false, error: 'goal-not-found' }
    const overrides = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
    const updated = normalizeGoal({ ...items[index], ...overrides, id: items[index].id, createdAt: items[index].createdAt })
    if (updated === null) return { ok: false, error: 'invalid-goal' }
    items[index] = updated
    state.goals = normalizeGoals(items)
    this.goalPulse = { at: Date.now(), ok: true, id: updated.id, line: `已更新目标「${updated.title}」` }
    this.store.touch()
    this.writeLive()
    return { ok: true, goal: updated }
  }

  /** Goals: delete one goal; selection falls back to the newest remaining goal. */
  deleteGoal(id) {
    const state = this.store.get()
    const before = normalizeGoals(state.goals).length
    state.goals = normalizeGoals(state.goals).filter((item) => item.id !== id)
    if (state.selectedGoalId === id) state.selectedGoalId = state.goals[0]?.id ?? null
    this.goalPulse = { at: Date.now(), ok: true, id, line: '已删除该目标' }
    this.store.touch()
    this.writeLive()
    return { ok: before - state.goals.length > 0, deleted: before - state.goals.length }
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

  /**
   * 今日任务指引卡。只读本地文件（soulmate 写的卡），缺失/无效回退到内置样例，
   * 永不抛错，保证面板永远有内容。读取是同步的、轻量的，view() 里直接调。
   */
  questGuide() {
    try {
      return loadQuestGuide({ dir: this.questGuideDir, date: dayKey() })
    } catch {
      return { ok: true, card: normalizeCard(DEFAULT_CARD), source: 'builtin:default' }
    }
  }

  /** Flush and release. */
  close() {
    this.stopDesktopBridge()
    this.store.close()
  }
}

export { defaultState }
