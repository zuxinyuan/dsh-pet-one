/**
 * Ideas — suggestion cards for the pet panel.
 *
 * This is the panel-local counterpart of Muse's Ideas tab: an idea
 * is a title plus an optional detail, with a status the user moves
 * by hand (new / trying / done / dismissed). Ideas are plain data
 * in the pet store (never in botharness.db). A future writer can
 * propose ideas from sessions or memories through the same shape.
 * @module dsh-pet-one/host/ideas
 */

export const IDEA_STATUSES = ['new', 'trying', 'done', 'dismissed']

function clean(value, max) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

/** Two follow-ups left open after the art tab, so the tab starts from real next work. */
export function seedIdeas() {
  return [
    {
      id: 'idea-art-auto',
      title: '每日回顾自动生成',
      detail: '每天定时从当天内容提炼一页艺术回顾，而不是手动创建。',
      status: 'new',
      createdAt: Date.parse('2026-10-24T00:00:00Z'),
    },
    {
      id: 'idea-art-image',
      title: '把插画换成指定图片或生图服务',
      detail: '艺术页目前是内联 SVG 示意图；以后给页面填 image URL，或接一个生图服务。',
      status: 'new',
      createdAt: Date.parse('2026-10-24T00:00:00Z'),
    },
  ]
}

/** Normalize one raw idea. Returns null when title is missing. */
export function normalizeIdea(input) {
  if (input === null || typeof input !== 'object') return null
  const title = clean(input.title, 200)
  if (title === '') return null
  return {
    id: clean(input.id, 128) || `idea-${Number(input.createdAt) || Date.now()}`,
    title,
    detail: clean(input.detail, 2000),
    status: IDEA_STATUSES.includes(input.status) ? input.status : 'new',
    createdAt: Number(input.createdAt) || Date.now(),
  }
}

/** Sort newest first, cap at 100 ideas (panel list, not an archive). */
export function normalizeIdeas(input) {
  if (!Array.isArray(input)) return []
  return input
    .map(normalizeIdea)
    .filter((idea) => idea !== null)
    .sort((a, b) => (b.createdAt - a.createdAt) || String(b.id).localeCompare(String(a.id)))
    .slice(0, 100)
}
