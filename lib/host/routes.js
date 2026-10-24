/**
 * HTTP surface — same-origin JSON endpoints the browser half polls. Plain
 * node request/response handlers; route registration happens in index.js
 * through `ctx.webServer.register`, matching the WebRoute shape used by the
 * official web plugins (`{kind, path, handler}`).
 * @module dsh-pet-one/host/routes
 */

import { readFile } from 'node:fs/promises'

/** Base path of the pet API. */
export const API_PREFIX = '/api/pet-one'

const BODY_LIMIT = 16 * 1024 * 1024

/** Write one JSON response. */
function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** Enforce one HTTP method (405 otherwise). */
function requireMethod(req, res, method) {
  if (req.method === method) return true
  json(res, 405, { ok: false, error: 'method-not-allowed' })
  return false
}

/** Read a bounded JSON body; resolves to `{}` for an empty body. */
function readJsonBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size === 0) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** Wrap a GET handler. */
function get(path, run) {
  return {
    kind: 'exact',
    path,
    handler: (req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      Promise.resolve()
        .then(run)
        .then((value) => json(res, 200, value), (error) => json(res, 500, { ok: false, error: messageOf(error) }))
    },
  }
}

/** Wrap a POST handler receiving the parsed body. */
function post(path, run) {
  return {
    kind: 'exact',
    path,
    handler: (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      readJsonBody(req)
        .then((body) => run(body))
        .then((value) => json(res, 200, value), (error) => json(res, 400, { ok: false, error: messageOf(error) }))
    },
  }
}

/** Error text safe for the wire. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Build every route for the pet service.
 * @param {import('./service.js').PetOneService} service
 */
export function makeRoutes(service) {
  const routes = [
    get(`${API_PREFIX}/state`, () => service.view()),
    get(`${API_PREFIX}/skins`, () => ({ ok: true, skins: service.skins.list() })),

    post(`${API_PREFIX}/interact`, (body) => service.interaction(String(body.kind ?? ''))),
    post(`${API_PREFIX}/config`, (body) => service.configure(body.patch ?? body)),
    post(`${API_PREFIX}/visible`, (body) => service.setVisible(body.visible !== false)),
    post(`${API_PREFIX}/say`, (body) => service.say(body.text)),
    post(`${API_PREFIX}/skins/import`, (body) => service.importAtlas(body)),
    post(`${API_PREFIX}/art/create`, (body) => service.createArtPage(body)),
    post(`${API_PREFIX}/art/select`, (body) => service.selectArt(body.artId ?? body.id)),
    post(`${API_PREFIX}/art/delete`, (body) => service.deleteArtPage(String(body.artId ?? body.id ?? ''))),
    post(`${API_PREFIX}/feed/create`, (body) => service.createFeedPost(body)),
    post(`${API_PREFIX}/feed/delete`, (body) => service.deleteFeedPost(String(body.feedId ?? body.id ?? ''))),
    post(`${API_PREFIX}/ideas/create`, (body) => service.createIdea(body)),
    post(`${API_PREFIX}/ideas/select`, (body) => service.selectIdea(body.ideaId ?? body.id)),
    post(`${API_PREFIX}/ideas/update`, (body) => service.updateIdea({ ...body, id: body.ideaId ?? body.id })),
    post(`${API_PREFIX}/ideas/delete`, (body) => service.deleteIdea(String(body.ideaId ?? body.id ?? ''))),
    post(`${API_PREFIX}/goals/create`, (body) => service.createGoal(body)),
    post(`${API_PREFIX}/goals/select`, (body) => service.selectGoal(body.goalId ?? body.id)),
    post(`${API_PREFIX}/goals/update`, (body) => service.updateGoal({ ...body, id: body.goalId ?? body.id })),
    post(`${API_PREFIX}/goals/delete`, (body) => service.deleteGoal(String(body.goalId ?? body.id ?? ''))),
    post(`${API_PREFIX}/skins/remove`, (body) => service.removeAtlas(String(body.id ?? ''))),
    post(`${API_PREFIX}/reset-position`, () => service.configure({ right: 24, bottom: 18 })),
  ]

  routes.push(get(`${API_PREFIX}/balance`, async (req) => service.balance(forceOf(req))))

  // Imported atlas images: /api/pet-one/skins/<id>/image
  routes.push({
    kind: 'prefix',
    path: `${API_PREFIX}/skins/`,
    handler: (req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      const path = (req.url ?? '').split('?')[0]
      const match = /^\/api\/pet-one\/skins\/([A-Za-z0-9_-]{1,40})\/image$/.exec(path)
      if (match === null) {
        json(res, 404, { ok: false, error: 'not-found' })
        return
      }
      const resolved = service.skins.imagePath(match[1])
      if (resolved === null) {
        json(res, 404, { ok: false, error: 'not-found' })
        return
      }
      readFile(resolved.file)
        .then((buffer) => {
          res.writeHead(200, {
            'content-type': resolved.mime,
            'cache-control': 'public, max-age=31536000, immutable',
            'content-length': buffer.byteLength,
          })
          res.end(buffer)
        })
        .catch(() => json(res, 500, { ok: false, error: 'read-failed' }))
    },
  })

  return routes
}

/** `?force=1` on the balance route bypasses the 60 s cache. */
function forceOf(req) {
  const url = req?.url ?? ''
  return /[?&]force=1\b/.test(url)
}
