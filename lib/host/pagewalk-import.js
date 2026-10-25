/**
 * Pagewalk → 任务指引 导入管线（quest-pagewalk 包）。
 *
 * Pagewalk 是本地隐私优先的 Chrome 扩展：录操作 → 自动截图 → 导出
 * 单文件 HTML / Markdown。本模块把一份「Pagewalk 导出物」整理成指引
 * 可用的形态，并**严格对齐** feat/quest-walkthrough-html 已落地的 schema：
 *
 *   guide.walkthrough.html  → 单文件图文讲解 HTML（内嵌截图，standalone）
 *   guide.media[]           → [{ type:'image', src, caption, hotspots? }]
 *
 * 不另起字段；复用 quest-guide.js 的 normalizeCard 做规整与校验。
 *
 * 设计取舍：
 * - 截图在 walkthrough HTML 里以 base64 内嵌，保证「单文件离线可用」（与
 *   Pagewalk 的 Standalone HTML 同义）；同时把截图原文件拷进 quest-guide/media/
 *   供 guide.media[] 引用（相对路径）。
 * - 只写 quest-guide 目录；不碰仓库其它位置、不写密钥、不碰 botharness.db。
 *
 * @module dsh-pet-one/host/pagewalk-import
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeCard, loadQuestGuide } from './quest-guide.js'

const HERE = dirname(fileURLToPath(import.meta.url))

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

/** 在 importDir 里找主导出文件：优先 pagewalk.html / index.html，其次 pagewalk.md。 */
function findExportFile(dir) {
  const candidates = ['pagewalk.html', 'index.html', 'pagewalk.htm', 'pagewalk.md', 'index.md']
  for (const name of candidates) {
    const p = join(dir, name)
    if (existsSync(p)) return { path: p, format: name.endsWith('.md') ? 'md' : 'html' }
  }
  // 退一步：目录里任意 .html / .md
  const files = readdirSync(dir)
  const html = files.find((f) => f.endsWith('.html') || f.endsWith('.htm'))
  if (html) return { path: join(dir, html), format: 'html' }
  const md = files.find((f) => f.endsWith('.md'))
  if (md) return { path: join(dir, md), format: 'md' }
  return null
}

function decodeBase64(dataUri) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUri)
  return m ? Buffer.from(m[2], 'base64') : null
}

/**
 * 解析一份 Pagewalk 导出物。
 * @param {string} dir 含导出文件的目录（quest-guide/imports/pagewalk/<card-id>/）
 * @returns {{format:string, title:string, steps:Array<{title:string, text:string, image:string|null}>, images:string[]}}
 */
export function parsePagewalkExport(dir) {
  const found = findExportFile(dir)
  if (!found) throw new Error(`在 ${dir} 找不到 Pagewalk 导出（pagewalk.html / index.html / *.md）`)
  const raw = readFileSync(found.path, 'utf8')
  return found.format === 'md'
    ? parseMarkdownExport(raw, dir)
    : parseHtmlExport(raw, dir)
}

/**
 * 解析 HTML 导出（Pagewalk「Standalone HTML」）。
 * 目标结构（与 Pagewalk 实际导出一致的常见形态）：
 *   <section class="pw-step"> <h3>Step 1: 点按钮</h3> <img src="shot1.png"> </section>
 * 容错：若无 .pw-step，则收集全部 <img>（按文档序）与全部「Step N」标题配对。
 */
export function parseHtmlExport(html, dir) {
  const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(html)
    || /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)
  const title = (titleMatch ? titleMatch[1] : 'Pagewalk 导出').replace(/\s+/g, ' ').trim()

  const stepBlocks = []
  const blockRe = /<section[^>]*class=["'][^"']*pw-step[^"']*["'][^>]*>([\s\S]*?)<\/section>/gi
  let bm
  while ((bm = blockRe.exec(html)) !== null) {
    const inner = bm[1]
    const img = /<img\b[^>]*\bsrc=["']([^"']+)["']/i.exec(inner)
    const heading = /<h\d[^>]*>([\s\S]*?)<\/h\d>/i.exec(inner)
    stepBlocks.push({
      text: stripTags(heading ? heading[1] : inner).replace(/\s+/g, ' ').trim(),
      image: img ? basename(img[1].split('?')[0]) : null,
    })
  }

  let steps
  if (stepBlocks.length > 0) {
    steps = stepBlocks
  } else {
    // 容错：全部 img + 全部 Step 标题
    const imgs = [...html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)]
      .map((m) => basename(m[1].split('?')[0]))
    const headings = [...html.matchAll(/<h\d[^>]*>([\s\S]*?)<\/h\d>/gi)]
      .map((m) => stripTags(m[1]).replace(/\s+/g, ' ').trim())
      .filter((t) => /step\s*\d/i.test(t))
    steps = zipSteps(headings, imgs)
  }

  return finalizeExport('html', title, steps, dir)
}

/**
 * 解析 Markdown 导出（Pagewalk「Markdown」）。
 * 目标结构：
 *   # 标题
 *   ## Step 1: 点按钮
 *   ![alt](shot1.png)
 */
export function parseMarkdownExport(md, dir) {
  const titleMatch = /^#\s+(.+)$/m.exec(md)
  const title = (titleMatch ? titleMatch[1] : 'Pagewalk 导出').trim()

  const stepBlocks = []
  const sectionRe = /^#{1,4}\s+(.+)\r?\n([\s\S]*?)(?=\r?\n#{1,4}\s+|$)/gm
  let sm
  while ((sm = sectionRe.exec(md)) !== null) {
    const heading = sm[1].trim()
    if (!/step\s*\d/i.test(heading)) continue
    const body = sm[2]
    const img = /!\[[^\]]*\]\(([^)\s]+)/.exec(body)
    stepBlocks.push({
      text: heading,
      image: img ? basename(img[1].split('?')[0]) : null,
    })
  }

  let steps
  if (stepBlocks.length > 0) {
    steps = stepBlocks
  } else {
    const imgs = [...md.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map((m) => basename(m[1].split('?')[0]))
    const headings = [...md.matchAll(/^#{1,4}\s+(.+)$/gm)]
      .map((m) => m[1].trim())
      .filter((t) => /step\s*\d/i.test(t))
    steps = zipSteps(headings, imgs)
  }

  return finalizeExport('md', title, steps, dir)
}

function zipSteps(headings, imgs) {
  const n = Math.max(headings.length, imgs.length)
  const out = []
  for (let i = 0; i < n; i += 1) {
    out.push({
      text: headings[i] || `Step ${i + 1}`,
      image: imgs[i] || null,
    })
  }
  return out
}

/** 收集 importDir 里真实存在的图片文件名，并去掉全空步骤。 */
function finalizeExport(format, title, steps, dir) {
  const present = new Set(readdirSync(dir).filter((f) => IMG_EXT.has(extname(f).toLowerCase())))
  const clean = steps
    .map((s) => ({
      title: s.text,
      text: s.text,
      image: s.image && present.has(s.image) ? s.image : (s.image && existsSync(join(dir, s.image)) ? s.image : null),
    }))
    .filter((s) => s.text || s.image)
  return { format, title, steps: clean, images: [...present] }
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ')
}

/** 按 src 去重 media 条目，保留首次出现（Pagewalk 新条目通常置前）。 */
function dedupeMedia(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    const key = item && item.src
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/**
 * 生成单文件图文讲解 HTML（standalone，截图以 base64 内嵌），
 * 视觉与 quest-walkthrough 样例同源（header + 步骤侧栏 + 截图列）。
 * @param {{title:string, caption:string, steps:Array<{text:string, image:string|null}>}} opts
 * @param {(imgName:string)=>string|null} base64Of 返回图片 base64 dataURI 或 null
 */
export function buildWalkthroughHtml({ title, caption, steps }, base64Of) {
  const shots = steps
    .filter((s) => s.image)
    .map((s, i) => {
      const uri = base64Of(s.image)
      const src = uri || `media/${s.image}` // 兜底相对路径
      return `      <figure class="shot">
        <figcaption>${escapeHtml(s.text || `步骤 ${i + 1}`)}</figcaption>
        <img src="${src}" alt="${escapeHtml(s.text || '')}" />
      </figure>`
    })
    .join('\n')

  const items = steps
    .map((s) => `        <li><p>${escapeHtml(s.text || '')}</p></li>`)
    .join('\n')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f6f8fa; color: #1f2328;
    font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 14px; line-height: 1.6; }
  header { padding: 14px 18px; background: #24292f; color: #fff; }
  header b { font-size: 15px; }
  header span { color: #9da7b3; font-size: 12px; }
  .wrap { display: flex; gap: 16px; padding: 18px; align-items: flex-start; flex-wrap: wrap; }
  .shots { flex: 1 1 420px; min-width: 320px; display: flex; flex-direction: column; gap: 14px; }
  .shot { margin: 0; border: 1px solid #d0d7de; border-radius: 10px; overflow: hidden; background: #fff; }
  .shot figcaption { padding: 8px 12px; font-weight: 600; border-bottom: 1px solid #eaeef2; }
  .shot img { display: block; width: 100%; height: auto; }
  .steps { flex: 0 1 260px; min-width: 220px; }
  .steps h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: #57606a; margin: 0 0 10px; }
  .steps ol { margin: 0; padding-left: 0; list-style: none; counter-reset: s; }
  .steps li { counter-increment: s; display: flex; gap: 10px; margin-bottom: 12px;
    background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 10px 12px; }
  .steps li::before { content: counter(s); flex: 0 0 22px; width: 22px; height: 22px; line-height: 22px;
    text-align: center; background: #ff4d4f; color: #fff; border-radius: 50%; font-weight: 600; font-size: 12px; }
  .steps li p { margin: 0; }
  .note { margin-top: 6px; font-size: 12px; color: #57606a; }
</style>
</head>
<body>
  <header>
    <b>${escapeHtml(title)}</b> &nbsp; <span>${escapeHtml(caption || 'Pagewalk 自动导出')}</span>
  </header>

  <div class="wrap">
    <div class="shots">
${shots || '      <p class="note">本讲解无截图（Pagewalk 导出未包含图片）。</p>'}
    </div>
    <div class="steps">
      <h2>照着点（${steps.length} 步）</h2>
      <ol>
${items}
      </ol>
      <p class="note">↑ 由 Pagewalk 录制自动生成；截图由导入管线内嵌，单文件离线可用。</p>
    </div>
  </div>
</body>
</html>
`
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 主入口：解析导入目录 → 生成 walkthrough HTML、拷截图、合并进 card.json。
 * @param {object} opts
 * @param {string} opts.importDir   Pagewalk 导出所在目录（含 pagewalk.html / *.md 与截图）
 * @param {string} opts.questGuideDir quest-guide 目录（落盘目标）
 * @param {string} opts.cardId      任务卡 id（也用于命名资产，避免冲突）
 * @param {string} [opts.caption]   walkthrough 副标题
 * @param {boolean} [opts.dryRun]   为 true 时不写盘，仅返回计划
 * @returns {{ok:boolean, walkthrough:object|null, media:object[], cardPath:string|null, written:string[]}}
 */
export function importPagewalk({ importDir, questGuideDir, cardId, caption, dryRun = false }) {
  if (!existsSync(importDir)) throw new Error(`导入目录不存在：${importDir}`)
  const parsed = parsePagewalkExport(importDir)
  const mediaDir = join(questGuideDir, 'media')
  const walkthroughName = `${cardId}-pagewalk.html`
  const walkthroughRel = `media/${walkthroughName}`

  // 1) 拷贝截图到 media/（加 cardId 前缀防冲突）
  const written = []
  const media = []
  for (const imgName of parsed.images) {
    const src = join(importDir, imgName)
    const destName = `${cardId}-${imgName}`
    const dest = join(mediaDir, destName)
    const rel = `media/${destName}`
    if (!dryRun) {
      mkdirSync(mediaDir, { recursive: true })
      copyFileSync(src, dest)
      written.push(dest)
    }
    // 找该截图所属步骤文案作为 caption
    const step = parsed.steps.find((s) => s.image === imgName)
    media.push({
      type: 'image',
      src: rel,
      caption: step?.text || imgName,
    })
  }

  // 2) 生成 standalone walkthrough HTML（截图 base64 内嵌）
  const base64Of = (imgName) => {
    const p = join(importDir, imgName)
    if (!existsSync(p)) return null
    const ext = extname(imgName).toLowerCase()
    const mime = MIME_BY_EXT[ext]
    if (!mime) return null
    const b64 = readFileSync(p).toString('base64')
    return `data:${mime};base64,${b64}`
  }
  const html = buildWalkthroughHtml(
    { title: parsed.title, caption: caption || parsed.title, steps: parsed.steps },
    base64Of,
  )
  const walkthroughHtmlOut = join(questGuideDir, walkthroughRel)
  if (!dryRun) {
    mkdirSync(mediaDir, { recursive: true })
    writeFileSync(walkthroughHtmlOut, html, 'utf8')
    written.push(walkthroughHtmlOut)
  }

  const walkthrough = media.length || parsed.steps.length
    ? { html: walkthroughRel, caption: caption || parsed.title }
    : null

  // 3) 合并进 card.json（保留既有 guide.*，只补 walkthrough / media；不覆盖既有 media）
  let cardPath = null
  if (!dryRun) {
    const cardJson = join(questGuideDir, 'card.json')
    const prev = existsSync(cardJson)
      ? normalizeCard(JSON.parse(readFileSync(cardJson, 'utf8')))
      : normalizeCard({ id: cardId, title: parsed.title, goal: parsed.title, guide: { steps: parsed.steps.map((s) => s.text) } })
    // 合并 media：Pagewalk 新截图置前，去重（按 src），保留既有条目（如 demo 热区截图）。
    const mergedMedia = dedupeMedia([...media, ...(prev.guide.media || [])])
    const merged = normalizeCard({
      ...prev,
      id: prev.id || cardId,
      title: prev.title || parsed.title,
      goal: prev.goal || parsed.title,
      guide: {
        ...prev.guide,
        walkthrough: walkthrough || prev.guide.walkthrough,
        media: mergedMedia,
      },
    })
    writeFileSync(cardJson, JSON.stringify(merged, null, 2) + '\n', 'utf8')
    cardPath = cardJson
    written.push(cardJson)
  }

  return { ok: true, walkthrough, media, cardPath, written }
}
