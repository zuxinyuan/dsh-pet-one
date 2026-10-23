/**
 * DSB 写入通道：把桌宠说的话送进 PersonaBot 的 DM，并唤醒 bot 回复。
 *
 * 与 `bots.js`（只读 SQLite）的分工：
 *   - `bots.js` 读阵容/定时，任何情况下都能用（只读文件/SQLite）
 *   - 本模块走 Cordis 服务 `botharness`，只有 DSB 装在同一 Profile 时才存在
 *
 * 为什么不在 `inject` 里声明 `botharness`：那样 DSB 一旦被禁用或升级失败，
 * 整个宠物插件会因为缺依赖而**加载不了**。这里改成运行时探测，
 * 拿不到就退化成“不支持发消息”，宠物照常工作（ADR-011 的同一条原则）。
 */
import { randomUUID } from 'node:crypto'

/** 探测 DSB 服务；没有就返回 null。 */
export function resolveDsb(ctx) {
  try {
    const dsb = ctx?.get?.('botharness')
    if (dsb === undefined || dsb === null) return null
    if (typeof dsb.channels?.appendMessage !== 'function') return null
    return dsb
  } catch {
    return null
  }
}

/** 找 bot 对应的 DM 频道 id。 */
export function dmChannelFor(dsb, botSlug) {
  try {
    const channels = dsb.channels.list()
    for (const record of channels) {
      if (record?.type === 'dm' && record?.botSlug === botSlug) return record.id
    }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * 以“人类”身份往 bot 的 DM 写一条消息并唤醒 bot。
 * @returns {Promise<{ok:boolean, messageId?:string, error?:string}>}
 */
export async function sendToBot(ctx, botSlug, body) {
  const text = String(body ?? '').trim()
  if (text === '') return { ok: false, error: 'empty' }

  const dsb = resolveDsb(ctx)
  if (dsb === null) return { ok: false, error: 'dsb-unavailable' }

  const channelId = dmChannelFor(dsb, botSlug)
  if (channelId === null) return { ok: false, error: 'no-dm-channel' }

  const messageId = `pet-one-${randomUUID()}`
  const message = {
    id: messageId,
    at: new Date().toISOString(),
    author: { kind: 'human', id: 'pet-one', name: '你' },
    body: text,
  }

  try {
    const appended = await dsb.channels.appendMessage(channelId, message, { source: 'pet-one' })
    if (appended === undefined || appended === null) {
      return { ok: false, error: 'channel-disappeared' }
    }
  } catch (error) {
    return { ok: false, error: `append-failed: ${error?.message ?? error}` }
  }

  // 唤醒 bot；失败不算发送失败（消息已经在频道里了）。
  try {
    const admission = dsb.runtime?.admitDmMessage?.({ channelId, messageId, body: text })
    if (admission && admission.admitted === false) {
      return { ok: true, messageId, error: `wake-skipped: ${admission.reason}` }
    }
  } catch (error) {
    return { ok: true, messageId, error: `wake-failed: ${error?.message ?? error}` }
  }

  return { ok: true, messageId }
}

/**
 * 经 Cordis `botharness.creations.create` 创建 PersonaBot（ADR-013：不直写 SQLite）。
 * @param {object} ctx
 * @param {{displayName:string, persona?:string, description?:string, roles?:string[], model?:string, preset?:string, operationKey?:string}} input
 * @returns {{ok:boolean, botSlug?:string, channelId?:string, displayName?:string, error?:string}}
 */
export function createPersonaBot(ctx, input = {}) {
  const displayName = String(input.displayName ?? '').trim()
  if (displayName === '') return { ok: false, error: 'empty-name' }
  if (displayName.length > 512) return { ok: false, error: 'name-too-long' }

  let dsb
  try {
    dsb = ctx?.get?.('botharness')
  } catch {
    dsb = null
  }
  if (dsb === undefined || dsb === null || typeof dsb.creations?.create !== 'function') {
    return { ok: false, error: 'dsb-unavailable' }
  }

  const payload = { displayName }
  if (typeof input.persona === 'string' && input.persona.trim() !== '') {
    payload.persona = input.persona.trim().slice(0, 60_000)
  }
  if (typeof input.description === 'string' && input.description.trim() !== '') {
    payload.description = input.description.trim().slice(0, 160)
  }
  if (Array.isArray(input.roles) && input.roles.length > 0) {
    payload.roles = input.roles
      .filter((role) => typeof role === 'string' && role.trim() !== '')
      .map((role) => role.trim().slice(0, 32))
      .slice(0, 8)
  }
  // Optional legacy model string / preset id (botharness CreatePersonaBotInput).
  if (typeof input.model === 'string' && input.model.trim() !== '') {
    payload.model = input.model.trim().slice(0, 256)
  }
  if (typeof input.preset === 'string' && input.preset.trim() !== '') {
    payload.preset = input.preset.trim().slice(0, 256)
  }

  // Idempotent key: 8–128 of [A-Za-z0-9._:-] (DSB validBotCreationKey).
  const operationKey =
    typeof input.operationKey === 'string' && input.operationKey.length >= 8
      ? input.operationKey
      : `petone-${randomUUID().replaceAll('-', '')}`

  try {
    const created = dsb.creations.create(payload, operationKey)
    const record = created?.record
    if (record === undefined || typeof record.slug !== 'string') {
      return { ok: false, error: 'creation-empty' }
    }
    return {
      ok: true,
      botSlug: record.slug,
      displayName: record.displayName ?? displayName,
      channelId: created.channelId ?? null,
      operationKey,
    }
  } catch (error) {
    const code = error?.code ?? error?.message ?? error
    return { ok: false, error: String(code) }
  }
}
