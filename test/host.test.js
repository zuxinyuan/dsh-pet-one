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
import { makeRoutes } from '../lib/host/routes.js'

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
