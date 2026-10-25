/**
 * Feed sources — pull X + YouTube content into the pet's 动态 panel.
 *
 * Design notes (MVP):
 * - No secrets are ever written into the repo. X is fetched from a
 *   user-supplied RSS base URL (e.g. their own nitter / RSSHub instance) via
 *   the `FEED_X_RSS_BASE` env var; if it is unset we fail-soft instead of
 *   hardcoding a token or endpoint. YouTube uses the public RSS feed, which
 *   needs no API key.
 * - Every fetch is fail-soft: a broken source returns `{ ok:false, reason }`
 *   and never throws, so the pet keeps working and the panel shows one line.
 * - `fetchImpl` is injectable so tests can drive the parse path with fake
 *   data instead of hitting the network.
 * @module dsh-pet-one/host/feed-sources
 */

import { normalizeFeedPost } from './feed.js'

/** Trim + length-cap a string (shared with feed.js's `clean`). */
function clean(value, max) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

/** Pull a `UC…` channel id out of a raw id or a channel/URL string. */
function extractChannelId(raw) {
  const value = clean(raw, 300)
  if (value === '') return ''
  if (/^UC[\w-]{10,}$/.test(value)) return value
  const fromUrl = /UC[\w-]{10,}/.exec(value)
  if (fromUrl) return fromUrl[0]
  return ''
}

/** Clamp the refresh interval to a sane range (0 = manual only). */
function clampRefresh(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(1440, Math.max(0, Math.floor(n)))
}

/** Sanitize the feed-source config. Only public, non-secret fields survive. */
export function normalizeFeedSourceConfig(input) {
  const cfg = input && typeof input === 'object' ? input : {}
  const x = cfg.x && typeof cfg.x === 'object' ? cfg.x : {}
  const yt = cfg.youtube && typeof cfg.youtube === 'object' ? cfg.youtube : {}
  return {
    x: {
      enabled: x.enabled === true,
      handle: clean(x.handle, 64).replace(/^@/, ''),
      keywords: clean(x.keywords, 200),
    },
    youtube: {
      enabled: yt.enabled === true,
      channelId: extractChannelId(yt.channelId || '') || extractChannelId(yt.channelUrl || ''),
      channelUrl: clean(yt.channelUrl, 300),
    },
    refreshMinutes: clampRefresh(cfg.refreshMinutes),
  }
}

/** Extract the text of the first matching XML tag from a block. */
function tag(block, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block)
  return m ? m[1].trim() : ''
}

/** Decode the handful of XML entities RSS/Atom actually uses. */
function decodeXml(value) {
  return clean(value, 10000)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** First `href="…"` inside a `<link …>` tag. */
function linkHref(block) {
  const m = /<link\b[^>]*\bhref="([^"]+)"/i.exec(block)
  if (m) return m[1]
  return tag(block, 'link')
}

/* ---------- YouTube (Atom feed, no key) ---------- */

function parseYouTubeRss(xml) {
  const entries = []
  const re = /<entry>([\s\S]*?)<\/entry>/gi
  let m
  while ((m = re.exec(xml))) entries.push(m[1])
  return entries.map((block) => {
    const id = tag(block, 'id')
    const title = decodeXml(tag(block, 'title'))
    const published = tag(block, 'published') || tag(block, 'updated')
    const link = linkHref(block)
    const summary = decodeXml(tag(block, 'media:description') || tag(block, 'summary') || tag(block, 'content'))
    return { id, title, published, link, summary }
  })
}

/** Turn one parsed YouTube entry into a feed post (or null). */
export function normalizeYouTubePost(entry) {
  if (!entry || typeof entry.id !== 'string') return null
  const videoId = entry.id.startsWith('yt:video:') ? entry.id.slice('yt:video:'.length) : entry.id
  if (videoId === '') return null
  const link = entry.link || `https://www.youtube.com/watch?v=${videoId}`
  return normalizeFeedPost({
    id: `youtube:${videoId}`,
    source: 'youtube',
    title: entry.title,
    text: entry.summary || entry.title,
    summary: entry.summary,
    link,
    createdAt: entry.published ? Date.parse(entry.published) : Date.now(),
  })
}

/** Fetch a channel's recent videos via its public RSS feed. */
export async function fetchYouTube(channelId, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch
  if (!channelId) return { ok: false, reason: 'no-channel' }
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`
  let res
  try {
    res = await fetchImpl(url)
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (!res || typeof res.ok !== 'boolean' || !res.ok) {
    return { ok: false, reason: `http-${res?.status || 'unknown'}` }
  }
  const xml = typeof res.text === 'function' ? await res.text() : String(res)
  const posts = parseYouTubeRss(xml)
    .map(normalizeYouTubePost)
    .filter((post) => post !== null)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 30)
  return { ok: true, posts }
}

/* ---------- X (RSS proxy; base URL supplied by the user, never a secret) ---------- */

function parseRssItems(xml) {
  const items = []
  const re = /<item>([\s\S]*?)<\/item>/gi
  let m
  while ((m = re.exec(xml))) items.push(m[1])
  return items.map((block) => {
    const title = decodeXml(tag(block, 'title'))
    const link = linkHref(block) || tag(block, 'link')
    const description = decodeXml(tag(block, 'description'))
    const pubDate = tag(block, 'pubDate')
    const guid = tag(block, 'guid')
    return { title, link, description, pubDate, guid }
  })
}

/** Turn one parsed X item into a feed post (or null). */
export function normalizeXPost(item) {
  if (!item || typeof item.link !== 'string') return null
  const status = /status\/(\d{2,})/.exec(item.link)
  const id = status ? status[1] : item.guid
  if (!id) return null
  return normalizeFeedPost({
    id: `x:${id}`,
    source: 'x',
    title: item.title,
    text: item.description || item.title,
    summary: item.description,
    link: item.link,
    createdAt: item.pubDate ? Date.parse(item.pubDate) : Date.now(),
  })
}

/**
 * Fetch X posts through a user-provided RSS base URL. The base comes from
 * `opts.xRssBase` (tests) then the `FEED_X_RSS_BASE` env var. When neither is
 * set we report `not-configured` rather than guessing an endpoint — no cloud
 * token is ever read or cached here.
 */
export async function fetchX(xConfig, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch
  const base = (opts.xRssBase || process.env.FEED_X_RSS_BASE || '').trim().replace(/\/+$/, '')
  if (!base) return { ok: false, reason: 'not-configured' }
  if (!xConfig || (!xConfig.handle && !xConfig.keywords)) return { ok: false, reason: 'no-handle' }
  const path = xConfig.handle ? `/${encodeURIComponent(xConfig.handle)}` : `/keyword/${encodeURIComponent(xConfig.keywords)}`
  let res
  try {
    res = await fetchImpl(base + path)
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (!res || typeof res.ok !== 'boolean' || !res.ok) {
    return { ok: false, reason: `http-${res?.status || 'unknown'}` }
  }
  const xml = typeof res.text === 'function' ? await res.text() : String(res)
  const posts = parseRssItems(xml)
    .map(normalizeXPost)
    .filter((post) => post !== null)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 30)
  return { ok: true, posts }
}

/**
 * Fetch every enabled source, fail-soft per source. Returns the merged posts
 * and a per-source error list so the panel can show one honest line.
 * @param {{x?: object, youtube?: object, refreshMinutes?: number}} config
 */
export async function fetchAllSources(config, opts = {}) {
  const cfg = normalizeFeedSourceConfig(config)
  const errors = []
  const posts = []
  if (cfg.youtube.enabled && cfg.youtube.channelId) {
    try {
      const r = await fetchYouTube(cfg.youtube.channelId, opts)
      if (r.ok) posts.push(...r.posts)
      else errors.push({ source: 'youtube', reason: r.reason })
    } catch {
      errors.push({ source: 'youtube', reason: 'fetch-failed' })
    }
  }
  if (cfg.x.enabled && (cfg.x.handle || cfg.x.keywords)) {
    try {
      const r = await fetchX(cfg.x, opts)
      if (r.ok) posts.push(...r.posts)
      else errors.push({ source: 'x', reason: r.reason })
    } catch {
      errors.push({ source: 'x', reason: 'fetch-failed' })
    }
  }
  return { ok: errors.length === 0, posts, errors }
}
