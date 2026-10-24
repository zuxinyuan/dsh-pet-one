/**
 * Tiny durable JSON store for the pet: one file under `<dshHome>/pet-one/`,
 * atomic rename writes, tolerant reads (a corrupt file falls back to
 * defaults), debounced flushes so a burst of interactions costs one write.
 * @module dsh-pet-one/host/store
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeArtPages } from './art.js'
import { normalizeFeedPosts } from './feed.js'
import { normalizeGoals } from './goals.js'
import { normalizeIdeas } from './ideas.js'

const SAVE_DEBOUNCE_MS = 120

/** Today's date key in local time (`YYYY-MM-DD`). */
export function dayKey(now = Date.now()) {
  const d = new Date(now)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** Factory defaults; every field is restored if the stored file misses it. */
export function defaultState() {
  return {
    version: 1,
    pet: {
      name: '小鲸',
      affinity: 0,
      pats: 0,
      feeds: 0,
      plays: 0,
      treats: 20,
      lastPatAt: 0,
      lastFeedAt: 0,
      lastPlayAt: 0,
    },
    display: {
      visible: true,
      size: 176,
      right: 24,
      bottom: 18,
      opacity: 1,
    },
    sound: true,
    quiet: false,
    skin: 'whale',
    ledger: {
      day: dayKey(),
      turns: 0,
      tools: 0,
      sessions: 0,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      contextTokens: 0,
      calls: 0,
    },
    life: {
      pats: 0,
      feeds: 0,
      plays: 0,
      turns: 0,
      days: [],
      packs: [],
      nightOwl: false,
    },
    progress: {
      achievements: {},
      memories: [],
      quests: { day: dayKey(), pat: 0, feed: 0, play: 0, turns: 0, claimed: [] },
    },
    say: null,
    // Last PersonaBot chosen in the pet panel (chat / history filter). Pet store only — never botharness.db.
    selectedBotSlug: null,
    // Art board: daily-review pages, newest first. Pet store only.
    artPages: [],
    selectedArtId: null,
    // Muse-like tabs: feed posts, idea cards and long-term goals. Pet store only.
    feedPosts: [],
    ideas: [],
    selectedIdeaId: null,
    goals: [],
    selectedGoalId: null,
  }
}

/** Clamp a number into a range, falling back when it is not finite. */
function clamp(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Merge one stored object over defaults, field by field (no deep surprises). */
function normalize(state) {
  const base = defaultState()
  if (state === null || typeof state !== 'object') return base
  const pet = state.pet && typeof state.pet === 'object' ? state.pet : {}
  const display = state.display && typeof state.display === 'object' ? state.display : {}
  const ledger = state.ledger && typeof state.ledger === 'object' ? state.ledger : {}
  const life = state.life && typeof state.life === 'object' ? state.life : {}
  const progress = state.progress && typeof state.progress === 'object' ? state.progress : {}
  return {
    version: 1,
    pet: {
      name: typeof pet.name === 'string' && pet.name.trim() !== '' ? pet.name.trim().slice(0, 24) : base.pet.name,
      affinity: Math.max(0, Math.floor(Number(pet.affinity) || 0)),
      pats: Math.max(0, Math.floor(Number(pet.pats) || 0)),
      feeds: Math.max(0, Math.floor(Number(pet.feeds) || 0)),
      plays: Math.max(0, Math.floor(Number(pet.plays) || 0)),
      treats: clamp(pet.treats, 0, 999, base.pet.treats),
      lastPatAt: Number(pet.lastPatAt) || 0,
      lastFeedAt: Number(pet.lastFeedAt) || 0,
      lastPlayAt: Number(pet.lastPlayAt) || 0,
    },
    display: {
      visible: display.visible !== false,
      size: clamp(display.size, 96, 320, base.display.size),
      right: clamp(display.right, -200, 4000, base.display.right),
      bottom: clamp(display.bottom, -200, 4000, base.display.bottom),
      opacity: clamp(display.opacity, 0.25, 1, base.display.opacity),
    },
    sound: state.sound !== false,
    quiet: state.quiet === true,
    skin: typeof state.skin === 'string' && state.skin !== '' ? state.skin : base.skin,
    ledger: {
      day: typeof ledger.day === 'string' ? ledger.day : base.ledger.day,
      turns: Math.max(0, Math.floor(Number(ledger.turns) || 0)),
      tools: Math.max(0, Math.floor(Number(ledger.tools) || 0)),
      sessions: Math.max(0, Math.floor(Number(ledger.sessions) || 0)),
      costUsd: Math.max(0, Number(ledger.costUsd) || 0),
      tokensIn: Math.max(0, Math.floor(Number(ledger.tokensIn) || 0)),
      tokensOut: Math.max(0, Math.floor(Number(ledger.tokensOut) || 0)),
      cacheRead: Math.max(0, Math.floor(Number(ledger.cacheRead) || 0)),
      contextTokens: Math.max(0, Math.floor(Number(ledger.contextTokens) || 0)),
      calls: Math.max(0, Math.floor(Number(ledger.calls) || 0)),
    },
    life: {
      pats: Math.max(0, Math.floor(Number(life.pats) || 0)),
      feeds: Math.max(0, Math.floor(Number(life.feeds) || 0)),
      plays: Math.max(0, Math.floor(Number(life.plays) || 0)),
      turns: Math.max(0, Math.floor(Number(life.turns) || 0)),
      days: Array.isArray(life.days) ? life.days.filter((d) => typeof d === 'string').slice(-400) : [],
      packs: Array.isArray(life.packs) ? life.packs.filter((p) => typeof p === 'string').slice(-50) : [],
      nightOwl: life.nightOwl === true,
    },
    progress: {
      achievements: progress.achievements && typeof progress.achievements === 'object'
        ? Object.fromEntries(Object.entries(progress.achievements).filter(([k, v]) => typeof k === 'string' && Number.isFinite(Number(v))).slice(-200))
        : {},
      memories: Array.isArray(progress.memories)
        ? progress.memories.filter((m) => m && typeof m.text === 'string').slice(-30).map((m) => ({ at: Number(m.at) || Date.now(), text: String(m.text).slice(0, 120) }))
        : [],
      quests: {
        day: typeof progress.quests?.day === 'string' ? progress.quests.day : base.progress.quests.day,
        pat: Math.max(0, Math.floor(Number(progress.quests?.pat) || 0)),
        feed: Math.max(0, Math.floor(Number(progress.quests?.feed) || 0)),
        play: Math.max(0, Math.floor(Number(progress.quests?.play) || 0)),
        turns: Math.max(0, Math.floor(Number(progress.quests?.turns) || 0)),
        claimed: Array.isArray(progress.quests?.claimed) ? progress.quests.claimed.filter((x) => typeof x === 'string') : [],
      },
    },
    say: state.say && typeof state.say === 'object' && typeof state.say.text === 'string'
      ? { text: String(state.say.text).slice(0, 200), at: Number(state.say.at) || Date.now() }
      : null,
    selectedBotSlug: typeof state.selectedBotSlug === 'string' && state.selectedBotSlug.trim() !== ''
      ? state.selectedBotSlug.trim().slice(0, 128)
      : null,
    artPages: normalizeArtPages(state.artPages),
    selectedArtId: typeof state.selectedArtId === 'string' && state.selectedArtId.trim() !== ''
      ? state.selectedArtId.trim().slice(0, 128)
      : null,
    feedPosts: normalizeFeedPosts(state.feedPosts),
    ideas: normalizeIdeas(state.ideas),
    selectedIdeaId: typeof state.selectedIdeaId === 'string' && state.selectedIdeaId.trim() !== ''
      ? state.selectedIdeaId.trim().slice(0, 128)
      : null,
    goals: normalizeGoals(state.goals),
    selectedGoalId: typeof state.selectedGoalId === 'string' && state.selectedGoalId.trim() !== ''
      ? state.selectedGoalId.trim().slice(0, 128)
      : null,
  }
}

/** Durable state handle shared by the host service. */
export class Store {
  /** @param {string} dir - directory holding `state.json`. */
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, 'state.json')
    this.data = this.#load()
    this.timer = null
    this.closed = false
  }

  #load() {
    try {
      if (!existsSync(this.file)) return defaultState()
      const raw = readFileSync(this.file, 'utf8')
      return normalize(JSON.parse(raw))
    } catch {
      return defaultState()
    }
  }

  /** Current mutable state (call `touch()` after mutating). */
  get() {
    return this.data
  }

  /** Replace the whole state (used by tests and reset paths). */
  set(next) {
    this.data = normalize(next)
    this.touch()
  }

  /** Schedule a debounced write. */
  touch() {
    if (this.closed) return
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, SAVE_DEBOUNCE_MS)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** Write immediately (atomic rename, mode 0600). */
  flush() {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    try {
      mkdirSync(this.dir, { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', 'utf8')
      try { chmodSync(tmp, 0o600) } catch { /* best effort */ }
      renameSync(tmp, this.file)
    } catch {
      /* never let a disk hiccup take the pet down */
    }
  }

  /** Stop timers and flush once. */
  close() {
    this.flush()
    this.closed = true
  }
}
