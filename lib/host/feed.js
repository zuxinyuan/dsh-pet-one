/**
 * Feed — short dynamic posts for the pet panel.
 *
 * This is the panel-local counterpart of Muse's Feed tab, without
 * Muse's background writer: posts are plain data in the pet store
 * (never in botharness.db). A post is one short text with a source
 * label, newest first. A future scheduled writer can create posts
 * through the same shape; the panel only lists, creates and deletes.
 * @module dsh-pet-one/host/feed
 */

function clean(value, max) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

/** First-run system note, so the tab is never empty and is honest about its source. */
export function seedFeedPost() {
  return {
    id: 'feed-panel-start',
    text: '动态页签已启用：这里可以手动记录动态，之后可以接定时生成。',
    source: 'panel',
    createdAt: Date.parse('2026-10-24T00:00:00Z'),
  }
}

/** Normalize one raw feed post. Returns null when text is missing. */
export function normalizeFeedPost(input) {
  if (input === null || typeof input !== 'object') return null
  const text = clean(input.text, 1000)
  if (text === '') return null
  return {
    id: clean(input.id, 128) || `feed-${Number(input.createdAt) || Date.now()}`,
    text,
    source: clean(input.source, 64) || 'manual',
    createdAt: Number(input.createdAt) || Date.now(),
  }
}

/** Sort newest first, cap at 100 posts (panel list, not an archive). */
export function normalizeFeedPosts(input) {
  if (!Array.isArray(input)) return []
  return input
    .map(normalizeFeedPost)
    .filter((post) => post !== null)
    .sort((a, b) => (b.createdAt - a.createdAt) || String(b.id).localeCompare(String(a.id)))
    .slice(0, 100)
}
