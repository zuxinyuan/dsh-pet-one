/**
 * 任务指引（星穹铁道式 daily task guide）host 侧加载与校验。
 *
 * 设计：只读本地任务卡（JSON 优先，YAML 兜底），soulmate 负责写卡。
 * 不写任何外部库、不碰云端；加载失败（文件缺失/格式错）一律回退到内置样例，
 * 保证面板永远有内容、服务永不抛错。
 *
 * @module dsh-pet-one/host/quest-guide
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 固定任务卡字段。soulmate 以后只填这些。 */
export const CARD_FIELDS = ['id', 'title', 'goal', 'accept', 'forbid', 'guide']

/**
 * 默认样例卡（今晚换题）。无本地卡时回退到此，保证面板永远有内容，
 * 也作为「上述样例必须能跑通指引」的权威来源（与 brief 中 YAML 样例同义）。
 */
export const DEFAULT_CARD = {
  id: '2026-10-25-galaxy-ops-12',
  title: '抄 galaxy-ops #5 含「12」的一行',
  goal: '打开 issue，把含「12」的那一行原样贴回；没看过就回「没看过」',
  accept: '用户贴出含「12」的原文一行，或明确「没看过」',
  forbid: '不要替用户总结 issue；不要编造 12 维内容',
  guide: {
    steps: [
      '打开浏览器或 gh：renderg-repo/galaxy-ops issue #5',
      '在正文里搜「12」',
      '把含「12」的那一整行原样复制',
      '粘贴给 soulmate；若没打开过就只回：没看过',
    ],
    paths: [
      'https://github.com/renderg-repo/galaxy-ops/issues/5',
      'gh issue view 5 -R renderg-repo/galaxy-ops',
    ],
    stuck_reply: '卡在登录/权限就说「打不开」；卡在找不到「12」就说「没找到」',
  },
}

/** 把任意输入规整成固定 schema（缺省给安全空值，超长截断）。 */
export function normalizeCard(raw) {
  const card = raw && typeof raw === 'object' ? raw : {}
  const guide = card.guide && typeof card.guide === 'object' ? card.guide : {}
  const asString = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value))
  const asList = (value) => (Array.isArray(value) ? value.map(asString).filter((item) => item !== '') : [])
  return {
    id: asString(card.id).slice(0, 120),
    title: asString(card.title).slice(0, 200),
    goal: asString(card.goal).slice(0, 500),
    accept: asString(card.accept).slice(0, 500),
    forbid: asString(card.forbid).slice(0, 500),
    guide: {
      steps: asList(guide.steps).slice(0, 20),
      paths: asList(guide.paths).slice(0, 20),
      stuck_reply: asString(guide.stuck_reply).slice(0, 500),
    },
  }
}

/** 校验；返回错误字符串数组（空数组表示通过）。不抛。 */
export function validateCard(card) {
  const errors = []
  if (!card.id) errors.push('缺少 id')
  if (!card.title) errors.push('缺少 title')
  if (!card.goal) errors.push('缺少 goal')
  if (!card.guide.steps.length) errors.push('guide.steps 为空')
  return errors
}

/**
 * 极简 YAML 解析：仅支持本任务卡用到的结构（2 空格缩进的 map + `- ` 列表 + 标量）。
 * 设计取舍：不支持行内注释（# 仅当整行 trim 后首字符为 # 时视为注释），
 * 这样样例里的 `issue #5` 不会被误判成注释。够 MVP 用，且 JSON 才是首选格式。
 * 任何解析异常由调用方兜底，不会外抛。
 */
export function parseYaml(text) {
  const lines = String(text).split(/\r?\n/)
  const root = {}
  const stack = [{ indent: -1, map: root, list: null, pendingKey: null }]
  const top = () => stack[stack.length - 1]

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length

    while (stack.length > 1 && indent <= top().indent) stack.pop()
    const frame = top()

    const listMatch = /^-\s+(.*)$/.exec(trimmed)
    if (listMatch) {
      const item = listMatch[1].replace(/^["']|["']$/g, '').trim()
      if (frame.list) frame.list.push(item)
      else if (frame.map && frame.pendingKey != null && Array.isArray(frame.map[frame.pendingKey])) {
        frame.map[frame.pendingKey].push(item)
      }
      continue
    }

    const kv = /^([^:]+):\s*(.*)$/.exec(trimmed)
    if (!kv) continue
    const key = kv[1].trim()
    const value = kv[2].replace(/^["']|["']$/g, '').trim()
    if (value === '') {
      // 空值：向下看一行判断是 list 还是 map（list 优先级）
      let j = i + 1
      while (j < lines.length && (lines[j].trim() === '' || lines[j].trim().startsWith('#'))) j += 1
      const nextTrim = j < lines.length ? lines[j].trim() : ''
      if (/^-\s+/.test(nextTrim)) {
        frame.map[key] = []
        stack.push({ indent, map: frame.map, list: frame.map[key], pendingKey: key })
      } else {
        frame.map[key] = {}
        stack.push({ indent, map: frame.map[key], list: null, pendingKey: null })
      }
    } else {
      frame.map[key] = value
    }
  }
  return root
}

/**
 * 加载今日任务卡。
 * 在 `dir` 目录（即 quest-guide 目录本身）下查找 card.{json,yaml,yml}，
 * 再查找 <date>.{json,yaml,yml}（date 由调用方传今天的日期键），
 * 都没有或无效则回退到内置 DEFAULT_CARD。
 * @param {{dir?: string, date?: string}} [options] dir 为 quest-guide 目录本身
 * @returns {{ok: boolean, card: object, source: string, errors?: string[], error?: string}}
 */
export function loadQuestGuide({ dir, date } = {}) {
  if (dir) {
    const base = dir
    const candidates = [
      join(base, 'card.json'),
      join(base, 'card.yaml'),
      join(base, 'card.yml'),
    ]
    if (date) {
      candidates.push(
        join(base, `${date}.json`),
        join(base, `${date}.yaml`),
        join(base, `${date}.yml`),
      )
    }
    for (const path of candidates) {
      if (!existsSync(path)) continue
      try {
        const text = readFileSync(path, 'utf8')
        const raw = path.endsWith('.json') ? JSON.parse(text) : parseYaml(text)
        const card = normalizeCard(raw)
        const errors = validateCard(card)
        if (errors.length === 0) return { ok: true, card, source: path }
        return { ok: false, card, source: path, errors }
      } catch (error) {
        return { ok: false, card: null, source: path, error: String(error?.message ?? error) }
      }
    }
  }
  return { ok: true, card: normalizeCard(DEFAULT_CARD), source: 'builtin:default' }
}
