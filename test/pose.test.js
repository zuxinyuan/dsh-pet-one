/**
 * Pose state machine tests — run with `node --test test/*.test.js`.
 * Pure-logic coverage of lib/host/pose.js plus a service/route round trip that
 * exercises the auto-switch and the setPose command entry.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { PoseMachine, POSES, REACTS } from '../lib/host/pose.js'
import { PetOneService } from '../lib/host/service.js'
import { makeRoutes } from '../lib/host/routes.js'
import { Store } from '../lib/host/store.js'
import { ActivityTracker } from '../lib/host/activity.js'

/** Deterministic clock factory for tests. */
function clock(start = 0) {
  let t = start
  const now = () => t
  now.advance = (ms) => { t += ms }
  return now
}

test('exposes the documented pose + reaction vocabulary', () => {
  assert.deepEqual(POSES, ['idle', 'working', 'celebrate', 'slack'])
  assert.deepEqual(REACTS, ['pet', 'drag'])
})

test('auto mode mirrors host activity: working on active, idle otherwise', () => {
  const m = new PoseMachine({ now: clock(0) })
  assert.equal(m.snapshot().pose, 'idle')

  m.syncFromActivity({ phase: 'thinking', activeCount: 1 })
  assert.equal(m.snapshot().pose, 'working')
  assert.equal(m.snapshot().mode, 'auto')

  m.syncFromActivity({ phase: 'idle', activeCount: 0 })
  assert.equal(m.snapshot().pose, 'idle')
})

test('inactive for slackAfterMs promotes idle -> slack (auto only)', () => {
  const m = new PoseMachine({ now: clock(0), slackAfterMs: 1000 })
  m.syncFromActivity({ phase: 'tool', activeCount: 1 })
  assert.equal(m.snapshot().pose, 'working')
  // go idle, then wait past the slack threshold
  m.syncFromActivity({ phase: 'idle', activeCount: 0 })
  assert.equal(m.snapshot().pose, 'idle')
  m.now.advance(1001)
  assert.equal(m.snapshot().pose, 'slack')
  // activity resumes -> back to working, slack cleared
  m.syncFromActivity({ phase: 'review', activeCount: 1 })
  assert.equal(m.snapshot().pose, 'working')
})

test('celebrate holds then settles back to the auto target', () => {
  const m = new PoseMachine({ now: clock(0), celebrateMs: 4000 })
  m.syncFromActivity({ phase: 'thinking', activeCount: 1 })
  m.celebrate()
  assert.equal(m.snapshot().pose, 'celebrate')
  // after the hold, falls back to auto (working, since the session is still active)
  m.now.advance(4001)
  assert.equal(m.snapshot().pose, 'working')
})

test('manual setPose overrides auto until ttl, then reverts', () => {
  const m = new PoseMachine({ now: clock(0) })
  m.syncFromActivity({ phase: 'idle', activeCount: 0 })
  const snap = m.setPose('working', { ttl: 1000 })
  assert.equal(snap.mode, 'manual')
  assert.equal(m.snapshot().pose, 'working')
  // even if host is active, manual wins
  m.syncFromActivity({ phase: 'tool', activeCount: 1 })
  assert.equal(m.snapshot().pose, 'working')
  m.now.advance(1001)
  // ttl expired -> auto, now working from activity
  assert.equal(m.snapshot().pose, 'working')
  assert.equal(m.snapshot().mode, 'auto')
})

test("setPose('auto') returns to auto mode", () => {
  const m = new PoseMachine({ now: clock(0) })
  m.setPose('slack')
  assert.equal(m.snapshot().mode, 'manual')
  m.setPose('auto')
  assert.equal(m.snapshot().mode, 'auto')
})

test('reject unknown pose / react with a clear error', () => {
  const m = new PoseMachine({ now: clock(0) })
  assert.throws(() => m.setPose('flying'), /unknown-pose/)
  assert.throws(() => m.react('boop'), /unknown-react/)
})

test('react transient overrides everything briefly, then clears', () => {
  const m = new PoseMachine({ now: clock(0) })
  m.setPose('working')
  m.react('pet')
  assert.equal(m.snapshot().pose, 'pet')
  assert.equal(m.snapshot().react, 'pet')
  m.now.advance(601)
  assert.equal(m.snapshot().pose, 'working')
})

test('service + route: POST /pose drives the published pose', async () => {
  const service = new PetOneService({ store: new Store(mkTmp()) })
  const routes = makeRoutes(service)
  const poseRoute = routes.find((r) => r.path === '/api/pet-one/pose')
  assert.ok(poseRoute, 'pose route registered')
  const reactRoute = routes.find((r) => r.path === '/api/pet-one/pose/react')
  assert.ok(reactRoute, 'pose/react route registered')

  // empty body -> service rejects with ok:false (unknown pose)
  const bad = jsonRes()
  poseRoute.handler(fakeReq({}), bad)
  const badBody = JSON.parse(await bad.text())
  assert.equal(badBody.ok, false)

  // valid setPose
  const res = jsonRes()
  poseRoute.handler(fakeReq({ pose: 'celebrate' }), res)
  const setBody = JSON.parse(await res.text())
  assert.equal(setBody.pose.pose, 'celebrate')
  assert.equal(setBody.pose.mode, 'manual')

  const view = service.view()
  assert.equal(view.pose, 'celebrate')
  assert.equal(view.poseMode, 'manual')

  // react route
  const r = jsonRes()
  reactRoute.handler(fakeReq({ kind: 'pet' }), r)
  const rBody = JSON.parse(await r.text())
  assert.equal(rBody.ok, true)
  assert.equal(rBody.pose.react, 'pet')
})

test('service view exposes sprite frames discovered on disk', () => {
  const service = new PetOneService({ store: new Store(mkTmp()) })
  const view = service.view()
  assert.ok(view.sprites && typeof view.sprites === 'object')
  // the generated placeholder frames should be present for the default skin
  assert.ok(Array.isArray(view.sprites.working), 'working frames resolved')
  assert.match(view.sprites.working[0], /\/api\/pet-one\/sprites\/whale\/working\/frame0\.png$/)
})

// --- tiny helpers to exercise routes without a real server ---
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function mkTmp() {
  return mkdtempSync(join(tmpdir(), 'pose-test-'))
}

/** A request stub that synchronously emits one JSON body. */
function fakeReq(bodyObj) {
  const data = Buffer.from(JSON.stringify(bodyObj ?? {}))
  return {
    method: 'POST',
    on(event, cb) {
      if (event === 'data') cb(data)
      if (event === 'end') cb()
    },
  }
}

/** A response stub that resolves `text()` once `end()` is called. */
function jsonRes() {
  const chunks = []
  let resolveEnd
  const done = new Promise((r) => { resolveEnd = r })
  return {
    statusCode: 200,
    headers: {},
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers) },
    end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolveEnd() },
    async text() { await done; return Buffer.concat(chunks).toString('utf8') },
  }
}
