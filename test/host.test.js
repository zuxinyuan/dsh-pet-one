/**
 * Host-side MVP tests — run with `node --test test/*.test.js`.
 * Covers the store, the event projection, the economy and a real HTTP round
 * trip through the route table (no DSH process needed).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Store, defaultState, dayKey } from '../lib/host/store.js'
import { ActivityTracker, projectEvent, emptyRuntime } from '../lib/host/activity.js'
import { interact, rewardTurn, rankOf } from '../lib/host/economy.js'
import { createSkinRegistry } from '../lib/host/skins.js'
import { PetOneService } from '../lib/host/service.js'
import { updatePersonaBot, deletePersonaBot, bindImChannel, resolveMeetingsSource, readMeetings, meetingAction } from '../lib/host/dsb.js'
import { makeRoutes } from '../lib/host/routes.js'
import { loadQuestGuide, normalizeCard, validateCard, DEFAULT_CARD } from '../lib/host/quest-guide.js'

/** Fresh temp dir per test. */
function tempDir() {
  return mkdtempSync(join(tmpdir(), 'pet-one-'))
}

/** 1x1 transparent PNG. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('store normalizes, persists and reloads', () => {
  const dir = tempDir()
  const store = new Store(dir)
  assert.equal(store.get().pet.name, '小鲸')
  store.get().pet.affinity = 33
  store.get().display.size = 240
  store.get().skin = 'sakura'
  store.close()

  const reopened = new Store(dir)
  assert.equal(reopened.get().pet.affinity, 33)
  assert.equal(reopened.get().display.size, 240)
  assert.equal(reopened.get().skin, 'sakura')
})

test('store clamps out-of-range values', () => {
  const dir = tempDir()
  const store = new Store(dir)
  store.set({ display: { size: 9999, opacity: -2, right: 'x' }, pet: { treats: 5000, affinity: -1 } })
  assert.equal(store.get().display.size, 320)
  assert.equal(store.get().display.opacity, 0.25)
  assert.equal(store.get().pet.treats, 999)
  assert.equal(store.get().pet.affinity, 0)
  store.close()
})

test('projection maps the official session vocabulary', () => {
  const rt = emptyRuntime()
  assert.deepEqual(projectEvent({ type: 'turn/start', data: {} }, rt)?.phase, 'waiting')
  assert.deepEqual(projectEvent({
    type: 'assistant/chunk',
    data: { chunk: { type: 'reasoning-delta', text: 'hmm' } },
  }, rt)?.phase, 'thinking')
  assert.deepEqual(projectEvent({
    type: 'tool/call',
    data: { callId: 'c1', name: 'shell' },
  }, rt)?.phase, 'tool')
  assert.equal(rt.tools.size, 1)
  const result = projectEvent({
    type: 'tool/result',
    data: { message: { content: [{ isError: false }], source: { callId: 'c1' } } },
  }, rt)
  assert.equal(result?.phase, 'thinking')
  assert.equal(rt.tools.size, 0)
  const turnEnd = projectEvent({ type: 'turn/end', data: { reason: { kind: 'completed' }, turn: 3 } }, rt)
  assert.equal(turnEnd?.phase, 'done')
  assert.equal(turnEnd?.turnCompleted, true)
  assert.equal(projectEvent({ type: 'turn/end', data: { reason: { kind: 'error' } } }, rt)?.phase, 'failed')
})

test('tracker aggregates priority across sessions and holds terminal phases', () => {
  const tracker = new ActivityTracker()
  tracker.onEvent({ id: 'a' }, { type: 'turn/start', data: {} })
  tracker.onEvent({ id: 'b' }, { type: 'tool/call', data: { callId: 'x', name: 'shell' } })
  const view = tracker.view()
  assert.equal(view.phase, 'tool')
  assert.equal(view.activeCount, 2)
  tracker.forget({ id: 'b' })
  assert.equal(tracker.view().phase, 'waiting')
  assert.equal(tracker.view().activeCount, 1)
})

test('economy gates pats, spends treats and pays turns', () => {
  const pet = defaultState().pet
  const first = interact(pet, 'pat', 1_000_000)
  assert.equal(first.ok, true)
  assert.equal(first.delta, 1)
  const again = interact(pet, 'pat', 1_001_000)
  assert.equal(again.delta, 0)
  assert.ok(again.cooldownMs > 0)

  pet.treats = 1
  const fed = interact(pet, 'feed', 1_005_000)
  assert.equal(fed.delta, 4)
  assert.equal(pet.treats, 0)
  const hungry = interact(pet, 'feed', 1_006_000)
  assert.equal(hungry.ok, false)
  assert.equal(hungry.error, 'no-treats')

  const before = pet.treats
  rewardTurn(pet)
  assert.equal(pet.treats, before + 1)
  assert.equal(rankOf(0).name, '初次见面')
  assert.equal(rankOf(900).name, '深海羁绊')
})

test('skin registry imports a spritesheet and serves its path', () => {
  const dir = tempDir()
  const registry = createSkinRegistry({ env: {}, dir })
  assert.equal(registry.list().length, 4)
  const skin = registry.importAtlas({
    name: 'demo',
    dataUrl: `data:image/png;base64,${PNG}`,
    cols: 8,
    rows: 9,
    fps: 6,
  })
  assert.equal(skin.kind, 'atlas')
  assert.equal(registry.list().length, 5)
  const image = registry.imagePath(skin.id)
  assert.ok(image && image.file.endsWith('.png'))
  assert.equal(registry.imagePath('../etc/passwd'), null)
  assert.equal(registry.removeAtlas(skin.id), true)
  assert.equal(registry.list().length, 4)
})

test('HTTP routes: state, interact, config, say, skins, balance', async () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  const routes = makeRoutes(service)
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    const exact = routes.find((route) => route.kind === 'exact' && route.path === path)
    if (exact) return exact.handler(req, res)
    const prefix = routes.find((route) => route.kind === 'prefix' && path.startsWith(route.path))
    if (prefix) return prefix.handler(req, res)
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  const state = await (await fetch(`${base}/api/pet-one/state`)).json()
  assert.equal(state.ok, true)
  assert.equal(state.phase, 'idle')
  assert.equal(state.pet.name, '小鲸')
  assert.equal(state.skins.length, 4)

  const pat = await (await fetch(`${base}/api/pet-one/interact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'pat' }),
  })).json()
  assert.equal(pat.delta, 1)

  const configured = await (await fetch(`${base}/api/pet-one/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch: { size: 200, skin: 'sakura', name: '阿鲸' } }),
  })).json()
  assert.equal(configured.display.size, 200)
  assert.equal(configured.skin, 'sakura')
  assert.equal(configured.pet.name, '阿鲸')

  const said = await (await fetch(`${base}/api/pet-one/say`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '你好呀' }),
  })).json()
  assert.equal(said.say.text, '你好呀')

  const balance = await (await fetch(`${base}/api/pet-one/balance`)).json()
  assert.equal(balance.ok, false)
  assert.equal(balance.reason, 'no-key')

  const skins = await (await fetch(`${base}/api/pet-one/skins`)).json()
  assert.equal(skins.skins.length, 4)

  service.close()
  await new Promise((resolve) => server.close(resolve))
})

test('a completed turn pays the pet and bumps the ledger', async () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  service.handleSessionEvent({ id: 's1' }, { type: 'turn/start', data: {} })
  assert.equal(service.view().phase, 'waiting')
  service.handleSessionEvent({ id: 's1' }, {
    type: 'tool/call',
    data: { callId: 'c1', name: 'shell' },
  })
  assert.equal(service.view().phase, 'tool')
  service.handleSessionEvent({ id: 's1' }, {
    type: 'turn/end',
    data: { reason: { kind: 'completed' }, turn: 1 },
  })
  const view = service.view()
  assert.equal(view.phase, 'done')
  assert.equal(view.ledger.turns, 1)
  assert.equal(view.ledger.tools, 1)
  assert.equal(view.pet.treats, 21)
  assert.ok(view.say?.text)
  service.close()
})

test('pet_say registers a registry-shaped tool and drives the bubble', async () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  const registered = []
  const fakeCtx = {
    on: () => () => {},
    get: (name) => (name === 'tools'
      ? { register: (definition) => { registered.push(definition); return () => {} } }
      : undefined),
  }
  service.attach(fakeCtx)
  assert.equal(registered.length, 1)
  const tool = registered[0]
  assert.equal(tool.name, 'pet_say')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['text'])
  assert.equal(typeof tool.output.render, 'function')
  const answer = await tool.execute({ text: '收工啦' })
  assert.match(answer, /收工啦/)
  assert.equal(service.view().say.text, '收工啦')
  service.close()
})

test('no tool service means the pet still loads', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  assert.doesNotThrow(() => service.attach({ on: () => () => {}, get: () => undefined }))
  service.close()
})

test('desktop bridge writes live.json and drains queued interactions', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  service.writeLive()
  const live = JSON.parse(readFileSync(join(dir, 'live.json'), 'utf8'))
  assert.equal(live.phase, 'idle')
  assert.ok(Number.isFinite(live.updatedAt))
  assert.equal(live.pet.name, '小鲸')

  writeFileSync(join(dir, 'commands.json'), JSON.stringify([{ kind: 'pat' }, { kind: 'feed' }]), 'utf8')
  service.drainDesktopCommands()
  assert.equal(service.store.get().pet.pats, 1)
  assert.equal(service.store.get().pet.feeds, 1)
  assert.equal(existsSync(join(dir, 'commands.json')), false)
  service.close()
})

test('levels, achievements and daily quests', async () => {
  const { defaultState } = await import('../lib/host/store.js')
  const { levelOf, checkAchievements, tickQuest, questView, touchDay } = await import('../lib/host/progress.js')
  assert.equal(levelOf(0).level, 1)
  assert.equal(levelOf(120).level, 3)
  assert.equal(levelOf(3000).title, '永恒的潮汐')

  const state = defaultState()
  state.life.pats = 1
  const unlocked = checkAchievements(state)
  assert.ok(unlocked.some((item) => item.id === 'first_pat'))
  assert.equal(checkAchievements(state).length, 0)

  state.progress.quests.pat = 0
  for (let i = 0; i < 4; i += 1) tickQuest(state, 'pat')
  assert.equal(questView(state).find((q) => q.id === 'pat5').done, false)
  const completed = tickQuest(state, 'pat')
  assert.equal(completed.length, 1)
  assert.equal(completed[0].id, 'pat5')
  assert.equal(questView(state).find((q) => q.id === 'pat5').done, true)

  touchDay(state, new Date(2026, 9, 23, 2, 0).getTime())
  assert.equal(state.life.days.length, 1)
  assert.equal(state.life.nightOwl, true)
})

test('assistant usage lands in the ledger', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  service.handleSessionEvent({ id: 's1' }, {
    type: 'assistant/message',
    data: { usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 900, totalTokens: 1050 } },
  })
  const view = service.view()
  assert.equal(view.ledger.tokensIn, 120)
  assert.equal(view.ledger.tokensOut, 30)
  assert.equal(view.ledger.cacheRead, 900)
  assert.equal(view.ledger.contextTokens, 1050)
  service.close()
})

test('chat follows up into the active session and captures the reply', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  const sent = []
  service.ctx = {
    get: (name) => (name === 'agents' ? { get: () => ({ followup: (message) => sent.push(message) }) } : undefined),
  }
  service.handleSessionEvent({ id: 's-chat' }, { type: 'turn/start', data: {} })
  const result = service.chat('在吗')
  assert.equal(result.ok, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].role, 'user')
  assert.equal(sent[0].content[0].text, '在吗')
  assert.equal(sent[0].source.kind, 'plugin')
  assert.equal(service.view().chat.pending, '在吗')

  service.handleSessionEvent({ id: 's-chat' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '在的，怎么啦' }] } },
  })
  service.handleSessionEvent({ id: 's-chat' }, {
    type: 'turn/end',
    data: { reason: { kind: 'completed' }, turn: 1 },
  })
  assert.equal(service.view().chat.reply.text, '在的，怎么啦')
  assert.equal(service.view().chat.pending, null)
  service.close()
})

test('chat without a live agent reports a friendly error', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  service.ctx = { get: () => undefined }
  const result = service.chat('有人吗')
  assert.equal(result.ok, false)
  assert.equal(service.view().chat.reply.error, true)
  assert.match(service.view().chat.reply.text, /没有活跃会话/)
  service.close()
})

test('bot roster is read-only and degrades to ok:false when DSB is absent', async () => {
  const { readBots, resetBotCache } = await import('../lib/host/bots.js')
  resetBotCache()
  // The real DSB home is the developer's; only assert the shape contract.
  const snapshot = await readBots()
  assert.equal(typeof snapshot.ok, 'boolean')
  assert.ok(Array.isArray(snapshot.bots))
  assert.ok(Array.isArray(snapshot.schedules))
  if (snapshot.ok) {
    for (const bot of snapshot.bots) {
      assert.equal(typeof bot.slug, 'string')
      assert.equal(typeof bot.name, 'string')
      assert.equal(typeof bot.hasAvatar, 'boolean')
      // Payloads must stay small: no base64 avatar, no full SOUL text.
      assert.ok(!('avatar' in bot))
      assert.ok((bot.memory?.soul ?? '').length <= 80)
    }
  } else {
    assert.equal(typeof snapshot.error, 'string')
  }
})

test('pet view always carries a bots field even before the first poll', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  const view = service.view()
  assert.ok(view.bots !== undefined)
  assert.equal(typeof view.bots.ok, 'boolean')
  assert.ok(Array.isArray(view.bots.bots))
  service.close()
})

test('chat to a bot degrades cleanly when DSB is not mounted', async () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  // ctx without a `botharness` service — the common case (DSB absent/disabled).
  service.ctx = { get: () => undefined }
  const result = service.chat('在吗', { target: 'bot', botSlug: 'bot-x' })
  assert.equal(result.ok, true)
  assert.equal(result.target, 'bot')
  await new Promise((resolve) => setTimeout(resolve, 50))
  const view = service.view()
  assert.equal(view.chat.reply.error, true)
  assert.match(view.chat.reply.text, /Bot 模式没开/)
  service.close()
})

test('bot bridge reports unavailable without DSB', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  service.ctx = { get: () => undefined }
  const view = service.view()
  assert.equal(view.botBridge.ok, false)
  service.close()
})

test('createBot degrades when DSB is not mounted', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  service.ctx = { get: () => undefined }
  const result = service.createBot({ displayName: '小研' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'dsb-unavailable')
  const view = service.view()
  assert.equal(view.botCreate.ok, false)
  assert.match(view.botCreate.line, /Bot 模式没开/)
  service.close()
})

test('createBot reuses botharness.creations.create when DSB is present', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  let seen = null
  service.ctx = {
    get(name) {
      if (name !== 'botharness') return undefined
      return {
        creations: {
          create(input, operationKey) {
            seen = { input, operationKey }
            return {
              record: { slug: 'bot-testslug', displayName: input.displayName },
              channelId: 'channel-dm-1',
            }
          },
        },
      }
    },
  }
  const result = service.createBot({
    displayName: '小研',
    persona: '你是助手',
    model: 'deepseek/deepseek-chat',
    preset: 'default-plan',
  })
  assert.equal(result.ok, true)
  assert.equal(result.botSlug, 'bot-testslug')
  assert.equal(seen.input.displayName, '小研')
  assert.equal(seen.input.persona, '你是助手')
  assert.equal(seen.input.model, 'deepseek/deepseek-chat')
  assert.equal(seen.input.preset, 'default-plan')
  assert.match(seen.operationKey, /^petone-[a-f0-9]{32}$/)
  const view = service.view()
  assert.equal(view.botCreate.ok, true)
  assert.match(view.botCreate.line, /小研/)
  service.close()
})

test('createBot omits blank model/preset from creations payload', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  let seen = null
  service.ctx = {
    get(name) {
      if (name !== 'botharness') return undefined
      return {
        creations: {
          create(input) {
            seen = input
            return { record: { slug: 'bot-blank', displayName: input.displayName }, channelId: 'ch' }
          },
        },
      }
    },
  }
  const result = service.createBot({ displayName: '空模', model: '  ', preset: '' })
  assert.equal(result.ok, true)
  assert.equal(seen.displayName, '空模')
  assert.equal('model' in seen, false)
  assert.equal('preset' in seen, false)
  service.close()
})

test('create-bot desktop command is drained into createBot', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  let called = null
  service.createBot = (input) => {
    called = input
    return { ok: true, botSlug: 'bot-x', displayName: input.displayName }
  }
  writeFileSync(
    join(dir, 'commands.json'),
    JSON.stringify([{
      kind: 'create-bot',
      displayName: '阿福',
      persona: '温和',
      model: 'provider/model-a',
      preset: 'preset-1',
    }]),
  )
  service.drainDesktopCommands()
  assert.deepEqual(called, {
    displayName: '阿福',
    persona: '温和',
    description: undefined,
    model: 'provider/model-a',
    preset: 'preset-1',
  })
  service.close()
})

test('chat desktop command keeps target bot through drainDesktopCommands', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  let called = null
  service.chat = (text, options = {}) => {
    called = { text, options }
    return { ok: true, target: options.target, botSlug: options.botSlug }
  }
  writeFileSync(
    join(dir, 'commands.json'),
    JSON.stringify([{ kind: 'chat', text: '你好', target: 'bot', botSlug: 'bot-tob' }]),
  )
  service.drainDesktopCommands()
  assert.deepEqual(called, { text: '你好', options: { target: 'bot', botSlug: 'bot-tob' } })
  service.close()
})

test('chat desktop command without target stays session chat', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  let called = null
  service.chat = (text, options = {}) => {
    called = { text, options }
    return { ok: true }
  }
  writeFileSync(
    join(dir, 'commands.json'),
    JSON.stringify([{ kind: 'chat', text: '会话消息' }]),
  )
  service.drainDesktopCommands()
  assert.deepEqual(called, { text: '会话消息', options: {} })
  service.close()
})

test('store persists selectedBotSlug', () => {
  const dir = tempDir()
  const store = new Store(dir)
  store.get().selectedBotSlug = 'bot-alpha'
  store.close()
  const reopened = new Store(dir)
  assert.equal(reopened.get().selectedBotSlug, 'bot-alpha')
  reopened.close()
})

test('selectBot persists and appears in view / live.json', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  service.botSnapshot = {
    ok: true,
    bots: [
      { slug: 'bot-a', name: '甲' },
      { slug: 'bot-b', name: '乙' },
    ],
    schedules: [],
    dm: { bot: 'bot-a' },
  }
  const result = service.selectBot('bot-b')
  assert.equal(result.ok, true)
  assert.equal(result.botSlug, 'bot-b')
  assert.equal(service.view().selectedBotSlug, 'bot-b')
  service.writeLive()
  const live = JSON.parse(readFileSync(join(dir, 'live.json'), 'utf8'))
  assert.equal(live.selectedBotSlug, 'bot-b')
  assert.equal(live.bots.ok, true)
  assert.equal(live.bots.bots.length, 2)
  service.close()
})

test('chat without botSlug uses persisted selectedBotSlug', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  service.botSnapshot = {
    ok: true,
    bots: [
      { slug: 'bot-first', name: 'First' },
      { slug: 'bot-picked', name: 'Picked' },
    ],
    schedules: [],
    dm: { bot: 'bot-first' },
  }
  service.selectBot('bot-picked')
  service.ctx = { get: () => undefined }
  const result = service.chat('你好', { target: 'bot' })
  assert.equal(result.ok, true)
  assert.equal(result.botSlug, 'bot-picked')
  service.close()
})

test('chat options.botSlug overrides store selection', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  service.botSnapshot = {
    ok: true,
    bots: [
      { slug: 'bot-store', name: 'Store' },
      { slug: 'bot-opt', name: 'Opt' },
    ],
    schedules: [],
    dm: null,
  }
  service.selectBot('bot-store')
  service.ctx = { get: () => undefined }
  const result = service.chat('覆盖', { target: 'bot', botSlug: 'bot-opt' })
  assert.equal(result.botSlug, 'bot-opt')
  service.close()
})

test('select-bot desktop command is drained into selectBot', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  let called = null
  service.selectBot = (slug) => {
    called = slug
    return { ok: true, botSlug: slug }
  }
  writeFileSync(
    join(dir, 'commands.json'),
    JSON.stringify([{ kind: 'select-bot', botSlug: 'bot-chosen' }]),
  )
  service.drainDesktopCommands()
  assert.equal(called, 'bot-chosen')
  service.close()
})

test('createBot success selects the new bot', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  service.ctx = {
    get(name) {
      if (name !== 'botharness') return undefined
      return {
        creations: {
          create(input) {
            return {
              record: { slug: 'bot-newborn', displayName: input.displayName },
              channelId: 'ch-new',
            }
          },
        },
      }
    },
  }
  const result = service.createBot({ displayName: '新生' })
  assert.equal(result.ok, true)
  assert.equal(service.store.get().selectedBotSlug, 'bot-newborn')
  assert.equal(service.view().selectedBotSlug, 'bot-newborn')
  service.close()
})

/* ---------- edit / delete / IM bind (in-panel) ---------- */

test('updatePersonaBot builds patch and calls registry.update', () => {
  let seen = null
  const ctx = {
    get(name) {
      if (name !== 'botharness') return undefined
      return { registry: { update(slug, patch) { seen = { slug, patch }; return { ok: true, record: { slug, displayName: patch.displayName } } } } }
    },
  }
  const result = updatePersonaBot(ctx, { botSlug: 'b1', displayName: '新名', model: 'provider/m', description: '简介', roles: ['r1', ''] })
  assert.equal(result.ok, true)
  assert.equal(seen.slug, 'b1')
  assert.equal(seen.patch.displayName, '新名')
  assert.equal(seen.patch.model, 'provider/m')
  assert.equal(seen.patch.description, '简介')
  assert.deepEqual(seen.patch.roles, ['r1'])
  // empty patch / blank slug rejected
  assert.equal(updatePersonaBot(ctx, { botSlug: 'b1' }).ok, false)
  assert.equal(updatePersonaBot(ctx, { botSlug: '' }).error, 'empty-slug')
  const noService = updatePersonaBot({ get: () => undefined }, { botSlug: 'b1', displayName: 'x' })
  assert.equal(noService.error, 'dsb-unavailable')
})

test('updateBot edits via registry.update and refreshes roster', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  let seen = null
  service.ctx = {
    get(name) {
      if (name !== 'botharness') return undefined
      return { registry: { update(slug, patch) { seen = { slug, patch }; return { ok: true, record: { slug, displayName: patch.displayName } } } } }
    },
  }
  const result = service.updateBot({ botSlug: 'bot-edit', displayName: '新名', model: 'provider/m', description: '简介' })
  assert.equal(result.ok, true)
  assert.equal(seen.slug, 'bot-edit')
  assert.equal(seen.patch.displayName, '新名')
  assert.equal(service.view().botAction.ok, true)
  assert.equal(service.view().botAction.kind, 'update')
  service.close()
})

test('updateBot degrades when DSB is not mounted', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  service.ctx = { get: () => undefined }
  const result = service.updateBot({ botSlug: 'bot-x', displayName: '名' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'dsb-unavailable')
  assert.equal(service.view().botAction.ok, false)
  assert.match(service.view().botAction.line, /Bot 模式没开/)
  service.close()
})

test('update-bot desktop command drains into updateBot', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  let called = null
  service.updateBot = (input) => { called = input; return { ok: true } }
  writeFileSync(join(dir, 'commands.json'), JSON.stringify([{ kind: 'update-bot', botSlug: 'bot-u', displayName: '改', model: 'p/m', description: 'd', roles: ['r1'] }]))
  service.drainDesktopCommands()
  assert.deepEqual(called, { botSlug: 'bot-u', displayName: '改', description: 'd', model: 'p/m', preset: undefined, roles: ['r1'] })
  service.close()
})

test('deletePersonaBot calls preview then confirm', async () => {
  let previewSlug = null
  let confirmArgs = null
  const ctx = {
    get(name) {
      if (name !== 'botharness') return undefined
      return { deletions: { preview(slug) { previewSlug = slug; return { token: 'tok-123', displayName: '要删' } }, confirm(slug, token, erase) { confirmArgs = { slug, token, erase }; return { displayName: '要删', phase: 'deleted', memory: 'cleared' } } } }
    },
  }
  const result = await deletePersonaBot(ctx, { botSlug: 'b-del', eraseMemory: true })
  assert.equal(result.ok, true)
  assert.equal(previewSlug, 'b-del')
  assert.equal(confirmArgs.token, 'tok-123')
  assert.equal(confirmArgs.erase, true)
  assert.equal(result.phase, 'deleted')
  assert.equal((await deletePersonaBot(ctx, { botSlug: '' })).error, 'empty-slug')
  assert.equal((await deletePersonaBot({ get: () => undefined }, { botSlug: 'x' })).error, 'dsb-unavailable')
})

test('deleteBot emits pending pulse, confirms, and clears selection', async () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  let called = null
  service.ctx = {
    get(name) {
      if (name !== 'botharness') return undefined
      return { deletions: { preview: () => ({ token: 't', displayName: 'x' }), confirm: (slug, token, erase) => { called = { slug, token, erase }; return { displayName: 'x', phase: 'deleted' } } } }
    },
  }
  service.store.get().selectedBotSlug = 'bot-del'
  service.store.touch()
  const result = service.deleteBot({ botSlug: 'bot-del', eraseMemory: false })
  assert.equal(result.ok, true)
  assert.equal(result.pending, true)
  const pulse = service.view().botAction
  assert.equal(pulse.kind, 'delete')
  assert.equal(pulse.pending, true)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(called.slug, 'bot-del')
  assert.equal(called.erase, false)
  assert.equal(service.store.get().selectedBotSlug, null)
  service.close()
})

test('delete-bot desktop command drains into deleteBot', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  let called = null
  service.deleteBot = (input) => { called = input; return { ok: true, pending: true } }
  writeFileSync(join(dir, 'commands.json'), JSON.stringify([{ kind: 'delete-bot', botSlug: 'bot-d', eraseMemory: true }]))
  service.drainDesktopCommands()
  assert.deepEqual(called, { botSlug: 'bot-d', eraseMemory: true })
  service.close()
})

test('bindImChannel validates fingerprint and dispatches to externalMessaging.identity', async () => {
  let seen = null
  const ctx = {
    get(name) {
      if (name !== 'botharness') return undefined
      return { externalMessaging: { identity: (slug, input) => { seen = { slug, input }; return { id: 'im-1' } } } }
    },
  }
  const ok = await bindImChannel(ctx, { botSlug: 'b', kind: 'bind', providerId: 'dsh-im/telegram', accountRef: 'a', fingerprint: 'a'.repeat(64) })
  assert.equal(ok.ok, true)
  assert.equal(seen.slug, 'b')
  assert.equal(seen.input.kind, 'bind')
  assert.equal(seen.input.providerId, 'dsh-im/telegram')
  assert.equal(seen.input.accountRef, 'a')
  const bad = await bindImChannel(ctx, { botSlug: 'b', kind: 'bind', providerId: 'p', accountRef: 'a', fingerprint: 'xyz' })
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'invalid-fingerprint')
  const ub = await bindImChannel(ctx, { botSlug: 'b', kind: 'unbind' })
  assert.equal(ub.ok, false)
  assert.equal(ub.error, 'invalid-unbind')
  const none = await bindImChannel({ get: () => undefined }, { botSlug: 'b', kind: 'bind', providerId: 'p', accountRef: 'a', fingerprint: 'a'.repeat(64) })
  assert.equal(none.error, 'dsb-unavailable')
})

test('bindIm dispatches via externalMessaging.identity', async () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  let seen = null
  service.ctx = {
    get(name) {
      if (name !== 'botharness') return undefined
      return { externalMessaging: { identity: (slug, input) => { seen = { slug, input }; return { id: 'im-1' } } } }
    },
  }
  const result = service.bindIm({ botSlug: 'bot-b', kind: 'bind', providerId: 'dsh-im/feishu', accountRef: 'a', fingerprint: 'f'.repeat(64) })
  assert.equal(result.ok, true)
  assert.equal(result.pending, true)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(seen.slug, 'bot-b')
  assert.equal(seen.input.kind, 'bind')
  assert.equal(service.view().botAction.ok, true)
  service.close()
})

test('bind-im desktop command drains into bindIm', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  let called = null
  service.bindIm = (input) => { called = input; return { ok: true, pending: true } }
  writeFileSync(join(dir, 'commands.json'), JSON.stringify([{ kind: 'bind-im', botSlug: 'bot-b', bindKind: 'bind', providerId: 'dsh-im/telegram', accountRef: 'a1', fingerprint: 'f'.repeat(64) }]))
  service.drainDesktopCommands()
  assert.deepEqual(called, { botSlug: 'bot-b', kind: 'bind', providerId: 'dsh-im/telegram', accountRef: 'a1', fingerprint: 'f'.repeat(64), id: undefined, expectedRevision: undefined, name: undefined, enabled: undefined, inheritEnabled: undefined })
  service.close()
})

test('resolveSelectedBotSlug falls back when stored slug left the roster', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  service.store.get().selectedBotSlug = 'bot-gone'
  service.store.touch()
  service.botSnapshot = {
    ok: true,
    bots: [{ slug: 'bot-still', name: 'Still' }],
    schedules: [],
    dm: { bot: 'bot-still' },
  }
  assert.equal(service.resolveSelectedBotSlug(), 'bot-still')
  service.close()
})

/* ---------- quest-guide (今日任务指引) ---------- */

test('quest-guide normalizes and validates a card', () => {
  const card = normalizeCard({
    id: 'x'.repeat(200),
    title: 't',
    goal: 'g',
    guide: { steps: ['a', 'b'], paths: ['https://e/x', 'gh issue view 1'] },
  })
  assert.equal(card.id.length, 120)
  assert.deepEqual(card.guide.steps, ['a', 'b'])
  assert.equal(validateCard(card).length, 0)
  // missing required fields => errors
  assert.ok(validateCard(normalizeCard({})).length > 0)
  // builtin default always validates
  assert.equal(validateCard(normalizeCard(DEFAULT_CARD)).length, 0)
})

test('quest-guide loader falls back to the builtin sample when the dir is empty', () => {
  const empty = tempDir()
  const result = loadQuestGuide({ dir: empty, date: dayKey() })
  assert.equal(result.ok, true)
  assert.equal(result.source, 'builtin:default')
  assert.equal(typeof result.card.id, 'string')
  assert.ok(result.card.guide.steps.length > 0)
})

test('quest-guide loader reads a fed card.json', () => {
  const base = tempDir()
  writeFileSync(join(base, 'card.json'), JSON.stringify({
    id: 'fed-card-1',
    title: '喂的卡',
    goal: '做点事',
    guide: { steps: ['第一步', '第二步'], paths: ['https://example.com'], stuck_reply: '卡住回一句' },
  }), 'utf8')
  const result = loadQuestGuide({ dir: base, date: dayKey() })
  assert.equal(result.ok, true)
  assert.ok(result.source.endsWith('card.json'))
  assert.equal(result.card.id, 'fed-card-1')
  assert.equal(result.card.title, '喂的卡')
  assert.deepEqual(result.card.guide.steps, ['第一步', '第二步'])
})

test('quest-guide service exposes the guide in view(), live.json and the HTTP route', async () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  const guide = service.questGuide()
  assert.equal(guide.ok, true)
  assert.equal(typeof guide.card.id, 'string')

  const view = service.view()
  assert.equal(view.questGuide.ok, true)
  assert.equal(view.questGuide.card.id, guide.card.id)

  service.writeLive()
  const live = JSON.parse(readFileSync(join(dir, 'live.json'), 'utf8'))
  assert.equal(live.questGuide.card.id, guide.card.id)

  // HTTP round trip through the route table
  const routes = makeRoutes(service)
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    const exact = routes.find((route) => route.kind === 'exact' && route.path === path)
    if (exact) return exact.handler(req, res)
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const fetched = await (await fetch(`${base}/api/pet-one/quest-guide`)).json()
  assert.equal(fetched.ok, true)
  assert.equal(typeof fetched.card.id, 'string')
  assert.ok(Array.isArray(fetched.card.guide.steps))
  service.close()
  await new Promise((resolve) => server.close(resolve))
})

test('quest-guide normalizes walkthrough + media (backward compatible)', () => {
  const card = normalizeCard({
    id: 'w1',
    title: 't',
    goal: 'g',
    guide: {
      steps: ['a'],
      walkthrough: { html: 'samples/x.html', caption: 'c' },
      media: [
        { type: 'image', src: 'media/pic.svg', caption: 'cap', hotspots: [{ x: 1, y: 2, w: 3, h: 4, label: 'L' }, { bad: true }] },
        { type: 'html', src: 'samples/y.html' },
        { type: 'image', src: '' }, // 无 src => 丢弃
      ],
    },
  })
  assert.equal(validateCard(card).length, 0)
  assert.deepEqual(card.guide.walkthrough, { html: 'samples/x.html', caption: 'c' })
  // 只保留合法 media（src 非空 + hotspot 合法）
  assert.equal(card.guide.media.length, 2)
  assert.equal(card.guide.media[0].type, 'image')
  assert.equal(card.guide.media[0].hotspots.length, 1)
  assert.equal(card.guide.media[0].hotspots[0].label, 'L')
  assert.equal(card.guide.media[1].type, 'html')

  // walkthrough 必须是 .html/.htm，否则丢弃
  assert.equal(normalizeCard({ id: 'w2', title: 't', goal: 'g', guide: { steps: ['a'], walkthrough: { html: 'evil.txt' } } }).guide.walkthrough, null)
  // 旧纯文字卡无 media/walkthrough 时仍可用（fail-soft）
  const plain = normalizeCard({ id: 'w3', title: 't', goal: 'g', guide: { steps: ['a'] } })
  assert.equal(plain.guide.walkthrough, null)
  assert.deepEqual(plain.guide.media, [])
})

test('quest-guide asset serving guards traversal and mime', () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'card.json'), JSON.stringify({ id: 'a', title: 't', goal: 'g', guide: { steps: ['s'] } }), 'utf8')
  writeFileSync(join(dir, 'walk.html'), '<!doctype html><p>walk</p>', 'utf8')
  writeFileSync(join(dir, 'pic.svg'), '<svg/>', 'utf8')
  // 目录外放一个敏感文件，资产路由绝不能读到
  const outside = join(dir, '..', 'secret.txt')
  writeFileSync(outside, 'TOPSECRET', 'utf8')

  const service = new PetOneService({ env: {}, dir, questGuideDir: dir })

  // 合法 html
  const okHtml = service.questGuideAsset('walk.html')
  assert.ok(okHtml && okHtml.mime.startsWith('text/html'))
  // 合法 svg
  const okSvg = service.questGuideAsset('pic.svg')
  assert.equal(okSvg && okSvg.mime, 'image/svg+xml')
  // 路径穿越被拒
  assert.equal(service.questGuideAsset('../secret.txt'), null)
  assert.equal(service.questGuideAsset('..%2fsecret.txt'), null)
  assert.equal(service.questGuideAsset('/etc/passwd'), null)
  // 非白名单扩展名被拒
  assert.equal(service.questGuideAsset('note.txt'), null)
  // 不存在被拒
  assert.equal(service.questGuideAsset('nope.html'), null)
  service.close()
})

test('quest-guide asset route serves through HTTP and blocks traversal', async () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'card.json'), JSON.stringify({ id: 'a', title: 't', goal: 'g', guide: { steps: ['s'] } }), 'utf8')
  writeFileSync(join(dir, 'walk.html'), '<!doctype html><p>walk</p>', 'utf8')
  const outside = join(dir, '..', 'secret2.txt')
  writeFileSync(outside, 'TOPSECRET2', 'utf8')

  const service = new PetOneService({ env: {}, dir, questGuideDir: dir })
  const routes = makeRoutes(service)
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    const exact = routes.find((route) => route.kind === 'exact' && route.path === path)
    if (exact) return exact.handler(req, res)
    const prefix = routes.find((route) => route.kind === 'prefix' && path.startsWith(route.path))
    if (prefix) return prefix.handler(req, res)
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  const ok = await fetch(`${base}/api/pet-one/quest-guide/asset?path=${encodeURIComponent('walk.html')}`)
  assert.equal(ok.status, 200)
  assert.ok((ok.headers.get('content-type') || '').startsWith('text/html'))
  assert.equal(await ok.text(), '<!doctype html><p>walk</p>')

  // 穿越被 404
  const bad = await fetch(`${base}/api/pet-one/quest-guide/asset?path=${encodeURIComponent('../secret2.txt')}`)
  assert.equal(bad.status, 404)

  service.close()
  await new Promise((resolve) => server.close(resolve))
})

/* ---------- 会议 / 日历（面板会议包） ---------- */

test('resolveMeetingsSource returns null without a calendar capability', () => {
  assert.equal(resolveMeetingsSource({ get: () => undefined }), null)
  assert.equal(resolveMeetingsSource({ get: () => ({}) }), null)
  // botharness present but no calendar/meetings namespace
  assert.equal(resolveMeetingsSource({ get: (n) => (n === 'botharness' ? { creations: {} } : undefined) }), null)
})

test('readMeetings degrades to ok:false when DSB calendar is absent', async () => {
  const snap = await readMeetings({ get: () => undefined })
  assert.equal(snap.ok, false)
  assert.equal(snap.reason, 'calendar-source-unavailable')
  assert.deepEqual(snap.meetings, [])
})

test('readMeetings normalizes a calendar.listEvents payload', async () => {
  const ctx = {
    get(name) {
      if (name !== 'botharness') return undefined
      return {
        calendar: {
          listEvents: async ({ from, to }) => {
            assert.ok(typeof from === 'string' && typeof to === 'string')
            return [
              { id: 'm1', title: '站会', startAt: '2026-10-24T09:30:00Z', provider: 'google', joinUrl: 'https://meet/x' },
              { id: 'm2', summary: '需求评审', startTime: '2026-10-24T14:00:00Z' },
              { notAnEvent: true },
            ]
          },
        },
      }
    },
  }
  const snap = await readMeetings(ctx)
  assert.equal(snap.ok, true)
  assert.equal(snap.meetings.length, 2)
  assert.equal(snap.meetings[0].id, 'm1')
  assert.equal(snap.meetings[0].title, '站会')
  assert.equal(snap.meetings[0].joinUrl, 'https://meet/x')
  assert.equal(snap.meetings[1].title, '需求评审')
  assert.equal(snap.meetings[1].startAt, '2026-10-24T14:00:00Z')
  // sorted by startAt
  assert.ok(snap.meetings[0].startAt < snap.meetings[1].startAt)
})

test('meetingAction join/open/message dispatch to the calendar capability', async () => {
  const seen = []
  const ctx = {
    get(name) {
      if (name !== 'botharness') return undefined
      return {
        calendar: {
          listEvents: async () => [],
          join: async (id) => { seen.push(['join', id]); return { ok: true } },
          open: async (id) => { seen.push(['open', id]); return { joinUrl: 'https://meet/open' } },
          sendMessage: async (id, text) => { seen.push(['message', id, text]); return { ok: true } },
        },
      }
    },
  }
  const join = await meetingAction(ctx, { action: 'join', meetingId: 'm1' })
  assert.equal(join.ok, true)
  const open = await meetingAction(ctx, { action: 'open', meetingId: 'm2' })
  assert.equal(open.ok, true)
  assert.equal(open.joinUrl, 'https://meet/open')
  const msg = await meetingAction(ctx, { action: 'message', meetingId: 'm1', text: '我晚两分钟' })
  assert.equal(msg.ok, true)
  assert.deepEqual(seen, [['join', 'm1'], ['open', 'm2'], ['message', 'm1', '我晚两分钟']])
})

test('meetingAction rejects unknown action / empty id / empty text / missing source', async () => {
  assert.equal((await meetingAction({ get: () => undefined }, { action: 'join', meetingId: 'm1' })).reason, 'calendar-source-unavailable')
  assert.equal((await meetingAction({ get: () => ({}) }, { action: 'join', meetingId: '' })).reason, 'empty-meeting-id')
  assert.equal((await meetingAction({ get: () => ({}) }, { action: 'frobnicate', meetingId: 'm1' })).reason, 'unknown-action')
  const ctx = {
    get(name) {
      if (name !== 'botharness') return undefined
      return { calendar: { listEvents: async () => [], sendMessage: async () => ({ ok: true }) } }
    },
  }
  assert.equal((await meetingAction(ctx, { action: 'message', meetingId: 'm1', text: '  ' })).reason, 'empty-text')
})

test('service meetingAction reports a friendly pulse when DSB calendar is absent', async () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  service.ctx = { get: () => undefined }
  const result = await service.meetingAction({ action: 'join', meetingId: 'm1' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'calendar-source-unavailable')
  const view = service.view()
  assert.equal(view.meetingPulse.ok, false)
  assert.match(view.meetingPulse.line, /DSB|日历/)
  service.close()
})

test('meeting desktop command drains into meetingAction', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  let called = null
  service.meetingAction = (input) => { called = input; return { ok: true, pending: true } }
  writeFileSync(join(dir, 'commands.json'), JSON.stringify([{ kind: 'meeting', action: 'open', meetingId: 'm9', joinUrl: 'https://x/y' }]))
  service.drainDesktopCommands()
  assert.deepEqual(called, { action: 'open', meetingId: 'm9', text: undefined, joinUrl: 'https://x/y' })
  service.close()
})

test('pet view always carries a meetings field', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  const view = service.view()
  assert.ok(view.meetings !== undefined)
  assert.equal(typeof view.meetings.ok, 'boolean')
  assert.ok(Array.isArray(view.meetings.meetings))
  service.close()
})

test('art board normalizes, seeds Day 8 and renders a standalone page', async () => {
  const { normalizeArtPage, normalizeArtPages, renderArtPageHtml, seedArtPage } = await import('../lib/host/art.js')
  const seed = seedArtPage()
  assert.equal(seed.date, '2026-10-17')
  assert.equal(seed.day, 8)
  assert.match(seed.insight, /one-sided limits exist and are finite/)
  assert.equal(normalizeArtPage({ date: 'bad', title: 'x', insight: 'y' }), null)
  assert.equal(normalizeArtPage({ date: '2026-10-18', title: '', insight: 'y' }), null)
  const pages = normalizeArtPages([seed, { date: '2026-10-18', day: 9, title: 'Next', insight: 'next insight', caption: 'cap' }])
  assert.equal(pages[0].date, '2026-10-18')
  assert.equal(pages[1].date, '2026-10-17')
  const html = renderArtPageHtml(seed)
  assert.match(html, /Discontinuity/)
  assert.match(html, /Two sides, two different answers/)
  assert.match(html, /<svg/)
})

test('service art board creates, selects and deletes pages via desktop commands', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  // Seeded Day 8 example is present on first run.
  let view = service.view()
  assert.equal(view.art.pages[0].id, '2026-10-17')
  assert.equal(view.selectedArtId, '2026-10-17')
  const created = service.createArtPage({ date: '2026-10-18', day: 9, title: 'Next Cut', insight: 'next insight', caption: 'next caption' })
  assert.equal(created.ok, true)
  assert.match(created.html, /Next Cut/)
  view = service.view()
  assert.equal(view.art.pages[0].id, '2026-10-18')
  assert.equal(view.selectedArtId, '2026-10-18')
  // Desktop command path: select back, then delete the new page.
  writeFileSync(join(dir, 'commands.json'), JSON.stringify([{ kind: 'select-art', artId: '2026-10-17' }]))
  service.drainDesktopCommands()
  assert.equal(service.view().selectedArtId, '2026-10-17')
  writeFileSync(join(dir, 'commands.json'), JSON.stringify([{ kind: 'delete-art', artId: '2026-10-18' }]))
  service.drainDesktopCommands()
  assert.equal(service.view().art.pages.length, 1)
  assert.equal(service.view().art.pages[0].id, '2026-10-17')
  service.close()
})

test('feed, ideas and goals normalize, seed and sort newest first', async () => {
  const { normalizeFeedPost, normalizeFeedPosts, seedFeedPost } = await import('../lib/host/feed.js')
  const { normalizeIdea, normalizeIdeas, seedIdeas } = await import('../lib/host/ideas.js')
  const { normalizeGoal, normalizeGoals, seedGoals } = await import('../lib/host/goals.js')
  assert.equal(seedFeedPost().source, 'panel')
  assert.equal(normalizeFeedPost({ text: '' }), null)
  assert.equal(normalizeFeedPosts([{ text: 'b', createdAt: 2 }, { text: 'a', createdAt: 1 }])[0].text, 'b')
  assert.equal(seedIdeas().length, 2)
  assert.equal(seedIdeas()[0].id, 'idea-art-auto')
  assert.equal(normalizeIdea({ title: '', detail: 'x' }), null)
  assert.equal(normalizeIdea({ title: 't', status: 'bogus' }).status, 'new')
  assert.equal(normalizeIdeas([{ title: 'b', createdAt: 2 }, { title: 'a', createdAt: 1 }])[0].title, 'b')
  assert.equal(seedGoals()[0].id, 'goal-example')
  assert.equal(normalizeGoal({ title: '' }), null)
  assert.equal(normalizeGoal({ title: 't', progress: 150 }).progress, 100)
  assert.equal(normalizeGoal({ title: 't', progress: -5 }).progress, 0)
  assert.equal(normalizeGoal({ title: 't', targetDate: 'bad' }).targetDate, null)
  assert.equal(normalizeGoal({ title: 't', targetDate: '2026-12-31' }).targetDate, '2026-12-31')
})

test('service feed, ideas and goals create, update, select and delete via desktop commands', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  // First-run seeds are present.
  let view = service.view()
  assert.equal(view.feed.posts[0].id, 'feed-panel-start')
  assert.equal(view.ideas.items.length, 2)
  assert.equal(view.selectedIdeaId, 'idea-art-auto')
  assert.equal(view.goals.items[0].id, 'goal-example')
  assert.equal(view.selectedGoalId, 'goal-example')
  // Feed: create then delete via desktop command.
  const post = service.createFeedPost({ text: 'hello feed' })
  assert.equal(post.ok, true)
  assert.equal(service.view().feed.posts[0].text, 'hello feed')
  writeFileSync(join(dir, 'commands.json'), JSON.stringify([{ kind: 'delete-feed', feedId: post.post.id }]))
  service.drainDesktopCommands()
  assert.equal(service.view().feed.posts.some((p) => p.id === post.post.id), false)
  // Ideas: create, move status via desktop command, select, delete.
  const idea = service.createIdea({ title: 'Try this', detail: 'detail' })
  assert.equal(idea.ok, true)
  assert.equal(service.view().selectedIdeaId, idea.idea.id)
  writeFileSync(join(dir, 'commands.json'), JSON.stringify([{ kind: 'update-idea', ideaId: idea.idea.id, status: 'trying' }]))
  service.drainDesktopCommands()
  assert.equal(service.view().ideas.items.find((i) => i.id === idea.idea.id).status, 'trying')
  writeFileSync(join(dir, 'commands.json'), JSON.stringify([{ kind: 'select-idea', ideaId: 'idea-art-auto' }]))
  service.drainDesktopCommands()
  assert.equal(service.view().selectedIdeaId, 'idea-art-auto')
  writeFileSync(join(dir, 'commands.json'), JSON.stringify([{ kind: 'delete-idea', ideaId: idea.idea.id }]))
  service.drainDesktopCommands()
  assert.equal(service.view().ideas.items.some((i) => i.id === idea.idea.id), false)
  // Goals: create, update progress via desktop command, select, delete.
  const goal = service.createGoal({ title: 'Read a book', targetDate: '2026-12-31' })
  assert.equal(goal.ok, true)
  assert.equal(service.view().selectedGoalId, goal.goal.id)
  writeFileSync(join(dir, 'commands.json'), JSON.stringify([{ kind: 'update-goal', goalId: goal.goal.id, progress: 40 }]))
  service.drainDesktopCommands()
  assert.equal(service.view().goals.items.find((g) => g.id === goal.goal.id).progress, 40)
  writeFileSync(join(dir, 'commands.json'), JSON.stringify([{ kind: 'select-goal', goalId: 'goal-example' }]))
  service.drainDesktopCommands()
  assert.equal(service.view().selectedGoalId, 'goal-example')
  writeFileSync(join(dir, 'commands.json'), JSON.stringify([{ kind: 'delete-goal', goalId: goal.goal.id }]))
  service.drainDesktopCommands()
  assert.equal(service.view().goals.items.some((g) => g.id === goal.goal.id), false)
  service.close()
})

/* ---------- feed sources (X + YouTube) ---------- */

test('normalizeFeedSourceConfig sanitizes and never keeps secrets', async () => {
  const { normalizeFeedSourceConfig } = await import('../lib/host/feed-sources.js')
  const cfg = normalizeFeedSourceConfig({
    x: { enabled: true, handle: '@elonmusk ', keywords: 'ai' },
    youtube: { enabled: true, channelUrl: 'https://www.youtube.com/channel/UC1234567890abcdefghijkl' },
    refreshMinutes: '15',
  })
  assert.equal(cfg.x.handle, 'elonmusk')
  assert.equal(cfg.x.keywords, 'ai')
  assert.equal(cfg.x.enabled, true)
  assert.equal(cfg.youtube.channelId, 'UC1234567890abcdefghijkl')
  assert.equal(cfg.refreshMinutes, 15)
  // out-of-range + junk clamped
  assert.equal(normalizeFeedSourceConfig({ refreshMinutes: 99999 }).refreshMinutes, 1440)
  assert.equal(normalizeFeedSourceConfig({ x: { handle: '   ' } }).x.enabled, false)
})

test('fetchYouTube parses the public Atom feed without a key', async () => {
  const { fetchYouTube } = await import('../lib/host/feed-sources.js')
  const xml = `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
    <entry>
      <id>yt:video:AAA111</id>
      <title>Hello World</title>
      <published>2026-10-01T10:00:00Z</published>
      <link rel="alternate" href="https://www.youtube.com/watch?v=AAA111"/>
      <media:group><media:description>A short summary.</media:description></media:group>
    </entry>
    <entry><id>yt:video:BBB222</id><title>Second</title><published>2026-10-02T10:00:00Z</published><link rel="alternate" href="https://www.youtube.com/watch?v=BBB222"/></entry>
  </feed>`
  const fetchImpl = async () => ({ ok: true, text: async () => xml })
  const r = await fetchYouTube('UC1234567890abcdefghijkl', { fetchImpl })
  assert.equal(r.ok, true)
  assert.equal(r.posts.length, 2)
  assert.equal(r.posts[0].id, 'youtube:BBB222') // newest first
  assert.equal(r.posts[0].source, 'youtube')
  assert.equal(r.posts[0].title, 'Second')
  assert.equal(r.posts[0].link, 'https://www.youtube.com/watch?v=BBB222')
  assert.equal(r.posts[1].summary, 'A short summary.')
  // missing channel id fails soft
  const bad = await fetchYouTube('', { fetchImpl })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'no-channel')
})

test('fetchX uses a user-supplied RSS base and fails soft without one', async () => {
  const { fetchX } = await import('../lib/host/feed-sources.js')
  const xml = `<rss version="2.0"><channel>
    <item><title>tweet</title><link>https://x.com/acct/status/12345</link><description>body text</description><pubDate>Wed, 01 Oct 2026 10:00:00 GMT</pubDate></item>
  </channel></rss>`
  const fetchImpl = async () => ({ ok: true, text: async () => xml })
  const r = await fetchX({ handle: 'acct' }, { fetchImpl, xRssBase: 'https://rsshub.example/x/user' })
  assert.equal(r.ok, true)
  assert.equal(r.posts.length, 1)
  assert.equal(r.posts[0].id, 'x:12345')
  assert.equal(r.posts[0].source, 'x')
  assert.equal(r.posts[0].link, 'https://x.com/acct/status/12345')
  // no base configured => fail soft, no thrown error, no secret
  const none = await fetchX({ handle: 'acct' }, { fetchImpl })
  assert.equal(none.ok, false)
  assert.equal(none.reason, 'not-configured')
})

test('fetchAllSources is fail-soft per source', async () => {
  const { fetchAllSources } = await import('../lib/host/feed-sources.js')
  const xml = '<rss version="2.0"><channel><item><title>t</title><link>https://x.com/a/status/999</link><description>d</description><pubDate>Wed, 01 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>'
  const fetchImpl = async (url) => {
    if (url.includes('youtube.com')) return { ok: false, status: 500, text: async () => '' }
    return { ok: true, text: async () => xml }
  }
  const result = await fetchAllSources(
    { x: { enabled: true, handle: 'a' }, youtube: { enabled: true, channelId: 'UC1234567890abcdefghijkl' }, refreshMinutes: 0 },
    { fetchImpl, xRssBase: 'https://rsshub.example/x/user' },
  )
  assert.equal(result.ok, false)
  assert.equal(result.posts.length, 1)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].source, 'youtube')
})

test('store persists feedSources and feedStatus', () => {
  const dir = tempDir()
  const store = new Store(dir)
  store.get().feedSources = { x: { enabled: true, handle: 'bob', keywords: '' }, youtube: { enabled: false, channelId: '', channelUrl: '' }, refreshMinutes: 30 }
  store.get().feedStatus = { ok: true, lastRefreshAt: 123, fetched: 5, errors: [] }
  store.close()
  const reopened = new Store(dir)
  assert.equal(reopened.get().feedSources.x.handle, 'bob')
  assert.equal(reopened.get().feedSources.refreshMinutes, 30)
  assert.equal(reopened.get().feedStatus.fetched, 5)
  reopened.close()
})

test('service refreshFeedSources merges source posts and dedupes manual', async () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  // manual post stays
  service.createFeedPost({ text: 'manual note', source: 'manual' })
  service.configureFeedSources({ x: { enabled: true, handle: 'a' }, refreshMinutes: 0 })
  const xml = '<rss version="2.0"><channel><item><title>t</title><link>https://x.com/a/status/777</link><description>d</description><pubDate>Wed, 01 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>'
  const fetchImpl = async () => ({ ok: true, text: async () => xml })
  const r = await service.refreshFeedSources({ fetchImpl, xRssBase: 'https://rsshub.example/x/user' })
  assert.equal(r.ok, true)
  assert.equal(r.fetched, 1)
  const view = service.view()
  assert.equal(view.feed.posts.some((p) => p.id === 'x:777'), true)
  assert.equal(view.feed.posts.some((p) => p.source === 'manual'), true)
  // second refresh upserts (no duplicate)
  await service.refreshFeedSources({ fetchImpl, xRssBase: 'https://rsshub.example/x/user' })
  assert.equal(service.view().feed.posts.filter((p) => p.id === 'x:777').length, 1)
  service.close()
})

test('configureFeedSources saves config and exposes it in the view', () => {
  const dir = tempDir()
  const service = new PetOneService({ env: {}, dir })
  const r = service.configureFeedSources({
    x: { enabled: true, handle: 'neo' },
    youtube: { enabled: true, channelUrl: 'https://www.youtube.com/channel/UC1234567890abcdefghijzz' },
    refreshMinutes: 20,
  })
  assert.equal(r.ok, true)
  assert.equal(r.sources.x.handle, 'neo')
  assert.equal(r.sources.youtube.channelId, 'UC1234567890abcdefghijzz')
  assert.equal(r.sources.refreshMinutes, 20)
  const view = service.view()
  assert.equal(view.feedSources.x.handle, 'neo')
  assert.equal(view.feedStatus.ok, false)
  service.close()
})
