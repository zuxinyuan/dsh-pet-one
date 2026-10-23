/**
 * Progression layer — levels/titles, achievements, daily quests and memories.
 * Everything is derived from the durable store and stays local; the desktop
 * shell receives the rendered view through `live.json`.
 * @module dsh-pet-one/host/progress
 */

import { dayKey } from './store.js'

/** Level thresholds; index+1 is the level number. */
export const LEVELS = [
  { min: 0, title: '初见', icon: '🌱' },
  { min: 40, title: '熟络', icon: '🫧' },
  { min: 120, title: '伙伴', icon: '🐋' },
  { min: 300, title: '挚友', icon: '💙' },
  { min: 800, title: '深海羁绊', icon: '🌊' },
  { min: 1600, title: '鲸群的祝福', icon: '✨' },
  { min: 3000, title: '永恒的潮汐', icon: '🌙' },
]

/** Level descriptor for an affinity total. */
export function levelOf(points) {
  let index = 0
  for (let i = 0; i < LEVELS.length; i += 1) {
    if (points >= LEVELS[i].min) index = i
  }
  const current = LEVELS[index]
  const next = LEVELS[index + 1] ?? null
  const span = next === null ? 1 : next.min - current.min
  const done = next === null ? 1 : (points - current.min) / span
  return {
    level: index + 1,
    title: current.title,
    icon: current.icon,
    min: current.min,
    next: next === null ? null : next.min,
    progress: Math.max(0, Math.min(1, done)),
  }
}

/** All achievements, with a predicate over the store state. */
export const ACHIEVEMENTS = [
  { id: 'first_pat', name: '第一次摸头', desc: '摸头 1 次', test: (s) => s.life.pats >= 1 },
  { id: 'pat_50', name: '摸头达人', desc: '累计摸头 50 次', test: (s) => s.life.pats >= 50 },
  { id: 'feed_10', name: '投喂十次', desc: '累计投喂 10 次', test: (s) => s.life.feeds >= 10 },
  { id: 'play_10', name: '陪玩十次', desc: '累计玩耍 10 次', test: (s) => s.life.plays >= 10 },
  { id: 'turn_10', name: '十个回合', desc: '完成 10 个 Agent 回合', test: (s) => s.life.turns >= 10 },
  { id: 'turn_100', name: '百回合', desc: '完成 100 个 Agent 回合', test: (s) => s.life.turns >= 100 },
  { id: 'level_3', name: '伙伴级', desc: '好感度达到 Lv.3', test: (s) => levelOf(s.pet.affinity).level >= 3 },
  { id: 'level_5', name: '深海羁绊', desc: '好感度达到 Lv.5', test: (s) => levelOf(s.pet.affinity).level >= 5 },
  { id: 'night_owl', name: '夜猫子', desc: '凌晨 0–6 点陪过它', test: (s) => s.life.nightOwl === true },
  { id: 'switch_pack', name: '换装时间', desc: '换过 2 个角色包', test: (s) => s.life.packs.length >= 2 },
  { id: 'streak_3', name: '三日陪伴', desc: '在 3 个不同日子出现', test: (s) => s.life.days.length >= 3 },
  { id: 'quest_first', name: '今日任务完成', desc: '完成任意一个每日任务', test: (s) => s.progress.quests.claimed.length >= 1 },
]

/** Daily quests; rewards are granted automatically on completion. */
export const QUESTS = [
  { id: 'pat5', name: '摸摸 5 次', stat: 'pat', target: 5, reward: 5 },
  { id: 'feed2', name: '投喂 2 次', stat: 'feed', target: 2, reward: 3 },
  { id: 'turns3', name: '完成 3 个回合', stat: 'turns', target: 3, reward: 5 },
]

/** Reset the daily quest slate when the local date changes. */
export function rollQuests(state, now = Date.now()) {
  const today = dayKey(now)
  const quests = state.progress.quests
  if (quests.day !== today) {
    state.progress.quests = { day: today, pat: 0, feed: 0, play: 0, turns: 0, claimed: [] }
  }
  return state.progress.quests
}

/** Tick one quest stat; returns completed quests that just paid out. */
export function tickQuest(state, stat, now = Date.now()) {
  const quests = rollQuests(state, now)
  if (!(stat in quests)) return []
  quests[stat] += 1
  const completed = []
  for (const quest of QUESTS) {
    if (quest.stat !== stat) continue
    if ((quests[stat] ?? 0) < quest.target) continue
    if (quests.claimed.includes(quest.id)) continue
    quests.claimed.push(quest.id)
    state.pet.treats = Math.min(99, state.pet.treats + quest.reward)
    completed.push({ ...quest, done: true })
  }
  return completed
}

/** Render quests for the panel. */
export function questView(state, now = Date.now()) {
  const quests = rollQuests(state, now)
  return QUESTS.map((quest) => ({
    id: quest.id,
    name: quest.name,
    reward: quest.reward,
    target: quest.target,
    progress: Math.min(quest.target, quests[quest.stat] ?? 0),
    done: quests.claimed.includes(quest.id),
  }))
}

/** Unlock any achievements whose predicate just became true. */
export function checkAchievements(state, now = Date.now()) {
  const unlocked = []
  for (const achievement of ACHIEVEMENTS) {
    if (state.progress.achievements[achievement.id] !== undefined) continue
    let ok = false
    try { ok = achievement.test(state) === true } catch { ok = false }
    if (!ok) continue
    state.progress.achievements[achievement.id] = now
    unlocked.push({ id: achievement.id, name: achievement.name, desc: achievement.desc, at: now })
    addMemory(state, `解锁成就「${achievement.name}」`, now)
  }
  return unlocked
}

/** Achievement list with unlock state. */
export function achievementView(state) {
  return ACHIEVEMENTS.map((achievement) => {
    const at = state.progress.achievements[achievement.id]
    return {
      id: achievement.id,
      name: achievement.name,
      desc: achievement.desc,
      unlocked: at !== undefined,
      at: at ?? null,
    }
  })
}

/** Append a memory line (de-duplicated tail, capped). */
export function addMemory(state, text, now = Date.now()) {
  const trimmed = String(text ?? '').trim().slice(0, 120)
  if (trimmed === '') return
  const memories = state.progress.memories
  const last = memories[memories.length - 1]
  if (last && last.text === trimmed) return
  memories.push({ at: now, text: trimmed })
  if (memories.length > 20) memories.splice(0, memories.length - 20)
}

/** Record that the pet appeared today (for the streak achievement). */
export function touchDay(state, now = Date.now()) {
  const today = dayKey(now)
  const days = state.life.days
  if (!days.includes(today)) {
    days.push(today)
    if (days.length > 400) days.splice(0, days.length - 400)
  }
  const hour = new Date(now).getHours()
  if (hour < 6) state.life.nightOwl = true
}
