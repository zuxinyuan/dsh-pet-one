/**
 * Affinity economy — pure-ish functions over the stored pet record. Same
 * spirit as the community pets (pat / feed / play, treats earned by real
 * work) but tuned for a short MVP loop: pats are cooldown-gated, feeding
 * spends a treat, every completed agent turn pays one treat.
 * @module dsh-pet-one/host/economy
 */

/** Affinity ranks, low to high. */
export const RANKS = [
  { min: 0, name: '初次见面', icon: '🌱' },
  { min: 40, name: '熟络', icon: '🫧' },
  { min: 120, name: '伙伴', icon: '🐋' },
  { min: 300, name: '挚友', icon: '💙' },
  { min: 800, name: '深海羁绊', icon: '🌊' },
]

const PAT_COOLDOWN_MS = 20_000
const PLAY_COOLDOWN_MS = 60_000
const PAT_GAIN = 1
const FEED_GAIN = 4
const PLAY_GAIN = 2
const TREAT_CAP = 99

const REACTIONS = {
  pat: ['咕噜咕噜～', '再摸一下嘛', '（眯起眼睛）', '今天的摸摸也很治愈', '鳍鳍拍水～'],
  feed: ['好次！是小鱼干！', '嚼嚼嚼……满足了', '谢谢投喂，能量 +1', '这条鱼干有点咸'],
  play: ['转圈圈！', '接住那颗泡泡了！', '再玩一次！', '（甩尾巴）'],
  cooldown: ['让我歇一下下～', '刚刚才摸过啦', '喘口气再来'],
  noTreats: ['零食罐空了……再干点活吧', '没有鱼干了，呜'],
  turn: ['又完成一轮！', '干得漂亮，奖励我一条鱼干', '这单收工～'],
}

/** Pick a random line from a pool. */
function pick(pool) {
  return pool[Math.floor(Math.random() * pool.length)]
}

/** Rank descriptor for an affinity point total. */
export function rankOf(points) {
  let current = RANKS[0]
  let next = null
  for (let i = 0; i < RANKS.length; i += 1) {
    if (points >= RANKS[i].min) {
      current = RANKS[i]
      next = RANKS[i + 1] ?? null
    }
  }
  const span = next === null ? 1 : next.min - current.min
  const done = next === null ? 1 : (points - current.min) / span
  return {
    name: current.name,
    icon: current.icon,
    min: current.min,
    next: next === null ? null : next.min,
    progress: Math.max(0, Math.min(1, done)),
  }
}

/** Read-only economy view shipped to the browser. */
export function economyView(pet) {
  return {
    name: pet.name,
    affinity: pet.affinity,
    rank: rankOf(pet.affinity),
    pats: pet.pats,
    feeds: pet.feeds,
    plays: pet.plays,
    treats: pet.treats,
  }
}

/**
 * Apply one interaction.
 * @param {object} pet - mutable pet record from the store.
 * @param {'pat'|'feed'|'play'} kind
 * @param {number} now - epoch ms.
 * @param {(line: string) => void} [onSay] - bubble hook.
 * @returns {{ok: boolean, delta: number, reaction: string, error?: string, cooldownMs?: number}}
 */
export function interact(pet, kind, now = Date.now(), onSay) {
  if (kind === 'pat') {
    const wait = pet.lastPatAt + PAT_COOLDOWN_MS - now
    if (wait > 0) {
      return { ok: true, delta: 0, reaction: pick(REACTIONS.cooldown), cooldownMs: wait }
    }
    pet.lastPatAt = now
    pet.pats += 1
    pet.affinity += PAT_GAIN
    const reaction = pick(REACTIONS.pat)
    onSay?.(reaction)
    return { ok: true, delta: PAT_GAIN, reaction }
  }
  if (kind === 'feed') {
    if (pet.treats < 1) return { ok: false, delta: 0, reaction: pick(REACTIONS.noTreats), error: 'no-treats' }
    pet.treats -= 1
    pet.lastFeedAt = now
    pet.feeds += 1
    pet.affinity += FEED_GAIN
    const reaction = pick(REACTIONS.feed)
    onSay?.(reaction)
    return { ok: true, delta: FEED_GAIN, reaction }
  }
  if (kind === 'play') {
    const wait = pet.lastPlayAt + PLAY_COOLDOWN_MS - now
    if (wait > 0) return { ok: true, delta: 0, reaction: pick(REACTIONS.cooldown), cooldownMs: wait }
    pet.lastPlayAt = now
    pet.plays += 1
    pet.affinity += PLAY_GAIN
    const reaction = pick(REACTIONS.play)
    onSay?.(reaction)
    return { ok: true, delta: PLAY_GAIN, reaction }
  }
  return { ok: false, delta: 0, reaction: '这家伙还不会这个动作', error: 'unknown-kind' }
}

/**
 * Pay the pet for one completed agent turn: one treat, plus a bubble line.
 * @param {object} pet - mutable pet record.
 * @param {number} [now]
 */
export function rewardTurn(pet, now = Date.now()) {
  pet.treats = Math.min(TREAT_CAP, pet.treats + 1)
  pet.affinity += 1
  return { treat: true, line: pick(REACTIONS.turn), at: now }
}
