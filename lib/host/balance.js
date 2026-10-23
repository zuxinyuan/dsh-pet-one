/**
 * DeepSeek account balance — best-effort, read-only, cached. Uses
 * `DEEPSEEK_API_KEY` from the host environment when present; the pet simply
 * shows "未配置" otherwise. Never blocks the UI: 4 s timeout, 60 s cache.
 * @module dsh-pet-one/host/balance
 */

const ENDPOINT = 'https://api.deepseek.com/user/balance'
const CACHE_MS = 60_000
const TIMEOUT_MS = 4_000

/** Pick the first non-empty API key from the environment. */
function apiKeyOf(env) {
  for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_KEY', 'DEEPSEEK_APIKEY']) {
    const value = env?.[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/**
 * Build a cached balance reader.
 * @param {{env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch}} [options]
 */
export function createBalanceReader(options = {}) {
  const env = options.env ?? process.env
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  let cache = { at: 0, value: null }
  let inflight = null

  async function read(force = false) {
    const key = apiKeyOf(env)
    if (key === '') return { ok: false, reason: 'no-key' }
    if (typeof fetchImpl !== 'function') return { ok: false, reason: 'no-fetch' }
    if (!force && cache.value !== null && Date.now() - cache.at < CACHE_MS) return cache.value
    if (inflight !== null) return inflight
    inflight = (async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      try {
        const response = await fetchImpl(ENDPOINT, {
          method: 'GET',
          headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
          signal: controller.signal,
        })
        if (!response.ok) {
          const failed = { ok: false, reason: `http-${response.status}` }
          cache = { at: Date.now(), value: failed }
          return failed
        }
        const body = await response.json()
        const info = Array.isArray(body?.balance_infos) ? body.balance_infos[0] : undefined
        const value = {
          ok: true,
          available: body?.is_available !== false,
          currency: typeof info?.currency === 'string' ? info.currency : 'CNY',
          total: numeric(info?.total_balance),
          granted: numeric(info?.granted_balance),
          topped: numeric(info?.topped_up_balance),
          at: Date.now(),
        }
        cache = { at: Date.now(), value }
        return value
      } catch {
        const failed = { ok: false, reason: 'network' }
        cache = { at: Date.now(), value: failed }
        return failed
      } finally {
        clearTimeout(timer)
        inflight = null
      }
    })()
    return inflight
  }

  return read
}

/** Parse a decimal string into a number, or null. */
function numeric(value) {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  return Number.isFinite(n) ? n : null
}
