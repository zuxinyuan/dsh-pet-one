/**
 * Bot 集成：只读 DeepSeekBot（deepseekbot / DSB）的 PersonaBot 数据。
 *
 * 设计约束（每条都是为了“DSB 出问题时宠物照样活”）：
 *   - 只读打开 SQLite（readOnly + 短超时），绝不写 DSB 的库
 *   - 任何异常都吞掉并返回 `{ ok:false }`，不抛给宠物服务
 *   - 不 import DSB 的包：只认它的数据目录，DSB 升级不影响我们
 *   - 头像 base64 不返回（几百 KB，面板用首字母圆标即可）
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()
const DSB_ROOT = join(HOME, '.dsh', 'botharness')
const DSB_DB = join(DSB_ROOT, 'botharness.db')
const BOTS_DIR = join(DSB_ROOT, 'bots')

/** 缓存 3 秒：面板每秒拉一次 live.json，不需要秒级刷库。 */
const TTL_MS = 3_000
let cache = { at: 0, value: null }

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 打开只读库；node:sqlite 在 Node 22 内置。 */
async function openDb() {
  if (!existsSync(DSB_DB)) return null
  try {
    const { DatabaseSync } = await import('node:sqlite')
    return new DatabaseSync(DSB_DB, { readOnly: true })
  } catch {
    return null
  }
}

/** 读 bot 的 Git Memory 摘要（不做 git 操作，只读文件）。 */
function memorySummary(slug) {
  const dir = join(BOTS_DIR, slug, 'memory')
  if (!existsSync(dir)) return null
  let soul = ''
  try {
    soul = readFileSync(join(dir, 'SOUL.md'), 'utf8').trim()
  } catch {
    /* 没有 SOUL.md 很正常 */
  }
  let files = 0
  try {
    files = readdirSync(dir).length
  } catch {
    /* ignore */
  }
  // SOUL.md 第一行有信息量，其余是模板；只取一行避免面板被塞满。
  const firstLine = soul.split('\n').find((line) => line.trim() && !line.startsWith('#'))?.trim() ?? ''
  return { files, soul: firstLine.slice(0, 80) }
}

/**
 * 收集 bot 快照。
 * @returns {Promise<{ok:boolean, bots:Array, schedules:Array, dm:object|null, error?:string}>}
 */
export async function readBots({ force = false } = {}) {
  const now = Date.now()
  if (!force && cache.value !== null && now - cache.at < TTL_MS) return cache.value

  const db = await openDb()
  if (db === null) {
    const value = { ok: false, bots: [], schedules: [], dm: null, error: 'dsb-not-found' }
    cache = { at: now, value }
    return value
  }

  try {
    const bots = []
    for (const row of db.prepare('SELECT body FROM persona_bots').all()) {
      const body = parseJson(row.body)
      if (body === null || typeof body.slug !== 'string') continue
      const { avatar, appearance, workspaces, ...rest } = body
      bots.push({
        slug: rest.slug,
        name: rest.displayName ?? rest.slug,
        createdAt: rest.createdAt ?? null,
        workspaces: (workspaces ?? []).length,
        hasAvatar: typeof avatar === 'string' && avatar.startsWith('data:'),
        appearance: appearance?.recipe?.outfit ?? null,
        memory: memorySummary(rest.slug),
      })
    }

    // 定时任务：只留可读字段，prompt 太长不上面板。
    const schedules = []
    try {
      for (const row of db.prepare('SELECT bot_slug, record_json, enabled FROM bot_schedules').all()) {
        const rec = parseJson(row.record_json)
        if (rec === null) continue
        schedules.push({
          bot: row.bot_slug,
          title: typeof rec.title === 'string' ? rec.title : '(未命名)',
          kind: rec.kind ?? null,
          enabled: row.enabled === 1 || row.enabled === true,
        })
      }
    } catch {
      /* 表不存在就算了 */
    }

    // DM 频道（每个 bot 一个）
    let dm = null
    try {
      const row = db.prepare('SELECT record_json FROM channel_records LIMIT 1').get()
      const rec = row ? parseJson(row.record_json) : null
      if (rec !== null) dm = { id: rec.id ?? null, name: rec.name ?? null, type: rec.type ?? null, bot: rec.botSlug ?? null }
    } catch {
      /* ignore */
    }

    // 正在跑的 Assignment（活动状态）
    let active = 0
    try {
      const row = db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE activity = 'working'").get()
      active = typeof row?.n === 'number' ? row.n : 0
    } catch {
      /* ignore */
    }

    // 最近一次定时任务触发 —— 方案 3 的事件源（bot 真的干了活）。
    let lastFiring = null
    try {
      const row = db
        .prepare('SELECT bot_slug, trigger, occurrence_at, fired_at, session_id, skipped_reason FROM bot_schedule_firings ORDER BY fired_at DESC LIMIT 1')
        .get()
      if (row) {
        lastFiring = {
          bot: row.bot_slug,
          trigger: row.trigger,
          occurrenceAt: row.occurrence_at,
          firedAt: row.fired_at,
          sessionId: row.session_id ?? null,
          skipped: row.skipped_reason ?? null,
        }
      }
    } catch {
      /* 老版本没这张表 */
    }

    // IM 渠道：把 DSB 支持的平台与已绑定账号对齐成一张表。
    const KNOWN = [
      ['telegram', 'Telegram'],
      ['feishu', '飞书'],
      ['lark', 'Lark'],
      ['slack', 'Slack'],
      ['discord', 'Discord'],
      ['qq', 'QQ'],
      ['wechat', '微信'],
      ['wecom', '企业微信'],
      ['dingtalk', '钉钉'],
      ['matrix', 'Matrix'],
      ['whatsapp', 'WhatsApp'],
    ]
    const bound = new Map()
    try {
      for (const row of db.prepare('SELECT platform, display_name, enabled FROM messaging_bindings WHERE revoked_at IS NULL').all()) {
        bound.set(String(row.platform), { name: row.display_name || '', enabled: row.enabled === 1 })
      }
    } catch {
      /* 老版本或缺表 */
    }
    const imChannels = KNOWN.map(([id, name]) => {
      const hit = bound.get(id)
      return {
        id,
        name,
        connected: hit !== undefined && hit.enabled !== false,
        detail: hit === undefined ? '未连接' : (hit.enabled === false ? '已绑定但停用' : (hit.name || '已连接')),
      }
    })

    const value = { ok: true, bots, schedules, dm, active, lastFiring, imChannels }
    cache = { at: now, value }
    return value
  } catch (error) {
    const value = { ok: false, bots: [], schedules: [], dm: null, error: String(error?.message ?? error) }
    cache = { at: now, value }
    return value
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
}

/** 供测试使用：清缓存。 */
export function resetBotCache() {
  cache = { at: 0, value: null }
}
