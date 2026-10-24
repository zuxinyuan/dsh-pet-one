/**
 * Auto-generation — daily review + feed summary, rule-based in v1.
 *
 * Trigger mode chosen by the user: scheduled daily generation plus a
 * manual theme override. The scheduled run uses only panel-local data
 * (ledger, quests, memories, today's feed posts, previous art pages),
 * never an external source, and never a model: no DeepSeek API key is
 * configured yet, so v1 picks a highlight by fixed rules instead of
 * calling a model. When a key exists, the same `buildDailyReview`
 * shape can be filled by a model without changing the panel.
 * A day with no activity and no theme produces nothing, rather than
 * a filler page. The illustration is the generic daily SVG, not the
 * discontinuity sketch used by the Day 8 example.
 * @module dsh-pet-one/host/autogen
 */

import { dayKey } from './store.js'
import { normalizeArtPage } from './art.js'
import { normalizeFeedPost } from './feed.js'
import { QUESTS } from './progress.js'

export const AUTO_TIME = '21:00'
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function clean(value, max) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

/** Default auto-generation settings for a fresh store. */
export function defaultAutoGen() {
  return { enabled: true, time: AUTO_TIME, lastRunDay: null, theme: '', themeDate: null }
}

/** Normalize stored auto-generation settings. */
export function normalizeAutoGen(input) {
  const base = defaultAutoGen()
  if (input === null || typeof input !== 'object') return base
  const time = clean(input.time, 5)
  const themeDate = clean(input.themeDate, 10)
  return {
    enabled: input.enabled !== false,
    time: TIME_RE.test(time) ? time : base.time,
    lastRunDay: typeof input.lastRunDay === 'string' && DATE_RE.test(input.lastRunDay) ? input.lastRunDay : null,
    theme: clean(input.theme, 200),
    themeDate: DATE_RE.test(themeDate) ? themeDate : null,
  }
}

/** The theme that applies to `date`, or '' when none was set for that day. */
export function effectiveTheme(autoGen, date) {
  const normalized = normalizeAutoGen(autoGen)
  return normalized.theme !== '' && normalized.themeDate === date ? normalized.theme : ''
}

/** True when the local clock is at the configured time and today has not run yet. */
export function shouldAutoRun(now, autoGen) {
  const normalized = normalizeAutoGen(autoGen)
  if (!normalized.enabled) return false
  const today = dayKey(now)
  if (normalized.lastRunDay === today) return false
  const d = new Date(now)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}` === normalized.time
}

/** Collect today's panel-local activity; returns null when there is none. */
function todayActivity(state, date) {
  const ledger = state?.ledger && typeof state.ledger === 'object' ? state.ledger : {}
  const quests = state?.progress?.quests && typeof state.progress.quests === 'object' ? state.progress.quests : {}
  const memories = Array.isArray(state?.progress?.memories) ? state.progress.memories : []
  const feedPosts = Array.isArray(state?.feedPosts) ? state.feedPosts : []
  const claimed = quests.day === date && Array.isArray(quests.claimed) ? quests.claimed : []
  const todayMemories = memories.filter((m) => m && dayKey(Number(m.at) || 0) === date && typeof m.text === 'string')
  const todayFeed = feedPosts.filter((p) => p && dayKey(Number(p.createdAt) || 0) === date && p.id !== 'feed-panel-start' && p.source !== 'auto' && !String(p.id).startsWith('feed-daily-'))
  const turns = ledger.day === date ? Math.max(0, Math.floor(Number(ledger.turns) || 0)) : 0
  const tools = ledger.day === date ? Math.max(0, Math.floor(Number(ledger.tools) || 0)) : 0
  const hasActivity = claimed.length > 0 || todayMemories.length > 0 || todayFeed.length > 0 || turns > 0 || tools > 0
  return {
    hasActivity,
    turns,
    tools,
    claimed,
    claimedNames: claimed.map((id) => QUESTS.find((q) => q.id === id)?.name).filter(Boolean),
    latestMemory: todayMemories[todayMemories.length - 1]?.text ?? '',
  }
}

function summaryLine(activity) {
  const parts = []
  if (activity.turns > 0) parts.push(`${activity.turns} 个回合`)
  if (activity.tools > 0) parts.push(`${activity.tools} 个工具`)
  if (activity.claimedNames.length > 0) parts.push(`完成了「${activity.claimedNames.join('、')}」`)
  return parts.length > 0 ? `今天共 ${parts.join('，')}。` : '今天没有留下回合或工具记录。'
}

/**
 * Build one daily-review page plus one feed summary for `date`.
 * Returns null when there is no activity and no theme (no filler page).
 * `theme`, when non-empty, overrides the rule-picked highlight.
 */
export function buildDailyReview(state, options = {}) {
  const now = options.now ?? Date.now()
  const date = options.date ?? dayKey(now)
  const theme = clean(options.theme, 200)
  const activity = todayActivity(state, date)
  if (!activity.hasActivity && theme === '') return null
  const summary = summaryLine(activity)
  let title = ''
  let insight = ''
  if (theme !== '') {
    title = theme
    insight = `今天的主题是「${theme}」。${summary}`
    if (activity.latestMemory !== '') insight += `记忆里留下了：${activity.latestMemory}`
  } else if (activity.claimedNames.length > 0) {
    title = activity.claimedNames[0]
    insight = `今天最值得留住的一点，是完成了「${activity.claimedNames.join('、')}」。${summary}`
  } else if (activity.latestMemory !== '') {
    title = activity.latestMemory.slice(0, 24)
    insight = `今天最值得留住的一点，是这条记忆：${activity.latestMemory}${summary}`
  } else {
    title = `${activity.turns > 0 ? `${activity.turns} 个回合` : '安静'}的一天`
    insight = `今天最值得留住的一点，是这一天本身。${summary}`
  }
  const page = normalizeArtPage({
    id: date,
    date,
    day: options.day ?? null,
    title,
    insight,
    caption: '规则提炼（未调用模型），等 API key 配好后可换成模型提炼。',
    illustration: { kind: 'svg', svg: 'daily' },
    createdAt: now,
  })
  if (page === null) return null
  const feedPost = normalizeFeedPost({
    id: `feed-daily-${date}`,
    text: `今日回顾已生成：${title}。${summary}`,
    source: 'auto',
    createdAt: now,
  })
  return { page, feedPost }
}
