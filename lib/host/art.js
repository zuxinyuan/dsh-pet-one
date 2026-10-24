/**
 * Art board — daily-review pages for the pet panel.
 *
 * One page per day, stored in the pet store (never in botharness.db).
 * A page is plain data: date, day number, title, one core insight,
 * an optional caption, and an illustration. The illustration is
 * deliberately not an AI image call: DeepSeek text models do not
 * generate images, so the panel renders a small inline SVG
 * (for example a discontinuity curve in an open book) or reuses
 * an image URL the user supplies. A future image-model provider
 * can fill `illustration.url` without changing this shape.
 * @module dsh-pet-one/host/art
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function clean(value, max) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/** The Day 8 example the user shared: discontinuity classification. */
export function seedArtPage() {
  return {
    id: '2026-10-17',
    date: '2026-10-17',
    day: 8,
    title: 'Discontinuity\nClassification\nCut',
    insight: 'For Day 8 today, October 17, I would hold on to one cut before you touch the nine problems: first class or second class is decided by whether both one-sided limits exist and are finite. The function value can settle whether the point is continuous, but it never decides that class.',
    caption: 'Two sides, two different answers — that difference is the classification.',
    illustration: { kind: 'svg', svg: 'discontinuity' },
    createdAt: Date.parse('2026-10-17T00:00:00Z'),
  }
}

/**
 * Normalize one raw art page. Returns null when date/title/insight are missing.
 * `id` defaults to `date`, so one day keeps one daily-review page.
 */
export function normalizeArtPage(input) {
  if (input === null || typeof input !== 'object') return null
  const date = clean(input.date, 10)
  if (!DATE_RE.test(date)) return null
  const title = clean(input.title, 200)
  const insight = clean(input.insight, 2000)
  if (title === '' || insight === '') return null
  const day = Number(input.day)
  const illustration = input.illustration && typeof input.illustration === 'object' ? input.illustration : {}
  const kind = illustration.kind === 'image' && typeof illustration.url === 'string' && illustration.url.trim() !== ''
    ? 'image'
    : 'svg'
  return {
    id: clean(input.id, 128) || date,
    date,
    day: Number.isFinite(day) && day > 0 ? Math.floor(day) : null,
    title,
    insight,
    caption: clean(input.caption, 200),
    illustration: kind === 'image'
      ? { kind: 'image', url: illustration.url.trim().slice(0, 2048) }
      : { kind: 'svg', svg: typeof illustration.svg === 'string' && illustration.svg.trim() !== '' ? illustration.svg.trim().slice(0, 64) : 'discontinuity' },
    createdAt: Number(input.createdAt) || Date.now(),
  }
}

/** Sort newest first, cap at 100 pages (panel list, not an archive). */
export function normalizeArtPages(input) {
  if (!Array.isArray(input)) return []
  return input
    .map(normalizeArtPage)
    .filter((page) => page !== null)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.createdAt - a.createdAt))
    .slice(0, 100)
}

/** Inline SVG for the open-book discontinuity sketch in the example page. */
export function artSvg(page) {
  if (page?.illustration?.kind === 'image') {
    return `<img src="${escapeHtml(page.illustration.url)}" alt="" style="width:100%;display:block;border-radius:12px" />`
  }
  return `<svg viewBox="0 0 600 260" role="img" aria-label="Discontinuity sketch" style="width:100%;display:block;background:#fdf8ef;border-radius:12px">
    <rect x="20" y="20" width="560" height="220" rx="10" fill="#fffdf6" stroke="#d8c9a8"/>
    <line x1="300" y1="30" x2="300" y2="230" stroke="#c9b896" />
    <path d="M60 180 C 140 180, 180 120, 260 110" fill="none" stroke="#333" stroke-width="2.5"/>
    <circle cx="260" cy="110" r="5" fill="#fff" stroke="#333" stroke-width="2"/>
    <path d="M340 70 C 420 70, 470 150, 540 190" fill="none" stroke="#333" stroke-width="2.5"/>
    <circle cx="340" cy="70" r="5" fill="#333"/>
    <text x="60" y="225" font-size="13" fill="#8a7a5a">left limit</text>
    <text x="430" y="225" font-size="13" fill="#8a7a5a">right limit</text>
  </svg>`
}

/**
 * Render one page as a standalone HTML daily-review page, in the
 * style of the example: beige paper, small date header, brown
 * handwritten-style title, one insight paragraph, a taped
 * illustration card, and an italic caption.
 */
export function renderArtPageHtml(page) {
  const normalized = normalizeArtPage(page)
  if (normalized === null) return null
  const titleHtml = escapeHtml(normalized.title).replace(/\n/g, '<br/>')
  const dayLine = normalized.day !== null ? `Day ${normalized.day} · ` : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(normalized.title.replace(/\n/g, ' '))}</title>
<style>
body{margin:0;background:#f3e8d8;color:#222;font-family:Georgia,serif}
main{max-width:680px;margin:0 auto;padding:32px 20px 48px}
.date{text-align:center;font-style:italic;color:#555}
h1{text-align:center;color:#a34a00;font-family:"Segoe Script","Bradley Hand",cursive;font-weight:700;font-size:56px;line-height:1.1;margin:16px 0 28px}
p.insight{font-size:20px;line-height:1.6;font-weight:700}
.card{background:#fff;border-radius:20px;padding:14px;box-shadow:0 2px 12px rgba(0,0,0,.12);position:relative;margin-top:36px}
.card:before{content:"";position:absolute;top:-12px;left:50%;transform:translateX(-50%) rotate(-2deg);width:110px;height:26px;background:rgba(255,255,255,.65)}
.caption{text-align:center;font-style:italic;color:#555;margin-top:14px}
</style></head><body><main>
<div class="date">${dayLine}${escapeHtml(normalized.date)}</div>
<h1>${titleHtml}</h1>
<p class="insight">${escapeHtml(normalized.insight)}</p>
<div class="card">${artSvg(normalized)}</div>
${normalized.caption ? `<div class="caption">${escapeHtml(normalized.caption)}</div>` : ''}
</main></body></html>
`
}
