/**
 * Pagewalk 导入管线测试 — run with `node --test test/*.test.js`.
 * 覆盖：HTML/MD 解析、standalone HTML 生成（base64 内嵌）、端到端导入与 card.json 合并。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parseHtmlExport,
  parseMarkdownExport,
  buildWalkthroughHtml,
  importPagewalk,
} from '../lib/host/pagewalk-import.js'
import { normalizeCard, validateCard } from '../lib/host/quest-guide.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'pw-import-'))
}

// 1x1 透明 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const HTML_EXPORT = `<!doctype html><html><head><meta charset="utf-8"><title>卡 A · Pagewalk</title></head><body>
  <h1>卡 A</h1>
  <section class="pw-step"><h3>Step 1: 打开页面</h3><img src="s1.png" alt="p1"></section>
  <section class="pw-step"><h3>Step 2: 点按钮</h3><img src="s2.png" alt="p2"></section>
</body></html>`

const MD_EXPORT = `# 卡 A

## Step 1: 打开页面
![p1](s1.png)

## Step 2: 点按钮
![p2](s2.png)
`

test('parseHtmlExport 解析 .pw-step 步骤与截图', () => {
  const dir = tempDir()
  writeFileSync(join(dir, 's1.png'), Buffer.from(PNG, 'base64'))
  writeFileSync(join(dir, 's2.png'), Buffer.from(PNG, 'base64'))
  const r = parseHtmlExport(HTML_EXPORT, dir)
  assert.equal(r.title, '卡 A · Pagewalk')
  assert.equal(r.steps.length, 2)
  assert.equal(r.steps[0].text, 'Step 1: 打开页面')
  assert.equal(r.steps[0].image, 's1.png')
  assert.equal(r.steps[1].image, 's2.png')
  assert.deepEqual(r.images.sort(), ['s1.png', 's2.png'])
})

test('parseMarkdownExport 解析 ## Step 步骤与截图', () => {
  const dir = tempDir()
  writeFileSync(join(dir, 's1.png'), Buffer.from(PNG, 'base64'))
  writeFileSync(join(dir, 's2.png'), Buffer.from(PNG, 'base64'))
  const r = parseMarkdownExport(MD_EXPORT, dir)
  assert.equal(r.title, '卡 A')
  assert.equal(r.steps.length, 2)
  assert.equal(r.steps[1].image, 's2.png')
  assert.deepEqual(r.images.sort(), ['s1.png', 's2.png'])
})

test('buildWalkthroughHtml 产出 standalone HTML（base64 内嵌截图）', () => {
  const dir = tempDir()
  writeFileSync(join(dir, 's1.png'), Buffer.from(PNG, 'base64'))
  const base64Of = (name) => {
    const ext = '.png'
    const mime = 'image/png'
    return `data:${mime};base64,${readFileSync(join(dir, name)).toString('base64')}`
  }
  const html = buildWalkthroughHtml(
    { title: '卡 A', caption: '副标题', steps: [{ text: 'Step 1: 打开页面', image: 's1.png' }] },
    base64Of,
  )
  assert.match(html, /<title>卡 A<\/title>/)
  assert.match(html, /data:image\/png;base64,/)
  assert.match(html, /照着点（1 步）/)
  // 没有外部相对引用（standalone）
  assert.doesNotMatch(html, /src=["']s1\.png["']/)
})

test('importPagewalk 端到端：写 walkthrough+截图，并合并不覆盖既有 media', () => {
  const importDir = tempDir()
  writeFileSync(join(importDir, 'pagewalk.html'), HTML_EXPORT)
  writeFileSync(join(importDir, 's1.png'), Buffer.from(PNG, 'base64'))
  writeFileSync(join(importDir, 's2.png'), Buffer.from(PNG, 'base64'))

  const qg = tempDir()
  // 预置一张既有 media（demo 热区截图），不应被覆盖
  const prevCard = normalizeCard({
    id: 'card-a', title: '卡 A', goal: 'g',
    guide: { steps: ['旧步骤'], media: [{ type: 'image', src: 'media/old.svg', caption: '旧截图', hotspots: [{ x: 1, y: 1, w: 2, h: 2 }] }] },
  })
  writeFileSync(join(qg, 'card.json'), JSON.stringify(prevCard, null, 2))

  const res = importPagewalk({ importDir, questGuideDir: qg, cardId: 'card-a', caption: '副标题' })
  assert.equal(res.ok, true)
  assert.equal(res.walkthrough.html, 'media/card-a-pagewalk.html')
  assert.equal(res.media.length, 2)

  // 落盘检查
  assert.ok(existsSync(join(qg, 'media', 'card-a-pagewalk.html')))
  assert.ok(existsSync(join(qg, 'media', 'card-a-s1.png')))
  assert.ok(existsSync(join(qg, 'media', 'card-a-s2.png')))

  // 合并后 card.json：既有 media 保留 + pagewalk media 追加，且校验通过
  const merged = normalizeCard(JSON.parse(readFileSync(join(qg, 'card.json'), 'utf8')))
  assert.equal(validateCard(merged).length, 0)
  assert.equal(merged.guide.media.length, 3, '既有 media 应被保留（追加，不覆盖）')
  assert.equal(merged.guide.media[2].src, 'media/old.svg')
  assert.equal(merged.guide.walkthrough.html, 'media/card-a-pagewalk.html')
})

test('importPagewalk dryRun 不写盘，只返回计划', () => {
  const importDir = tempDir()
  writeFileSync(join(importDir, 'pagewalk.html'), HTML_EXPORT)
  writeFileSync(join(importDir, 's1.png'), Buffer.from(PNG, 'base64'))
  writeFileSync(join(importDir, 's2.png'), Buffer.from(PNG, 'base64'))
  const qg = tempDir()
  const before = readdirSync(qg)
  const res = importPagewalk({ importDir, questGuideDir: qg, cardId: 'card-a', dryRun: true })
  assert.equal(res.cardPath, null)
  assert.equal(res.written.length, 0)
  assert.deepEqual(readdirSync(qg), before, 'dryRun 不应产生任何文件')
  assert.equal(res.media.length, 2)
})
