#!/usr/bin/env node
/**
 * Pagewalk 导入 CLI（quest-pagewalk 包）。
 *
 * 用法：
 *   node bin/pagewalk-import.mjs <cardId> [importDir] [--caption "副标题"] [--dry-run] [--quest-guide-dir <dir>]
 *
 * 示例：
 *   node bin/pagewalk-import.mjs 2026-10-25-galaxy-ops-12
 *   node bin/pagewalk-import.mjs 2026-10-25-galaxy-ops-12 quest-guide/imports/pagewalk/2026-10-25-galaxy-ops-12 --caption "照着点：从列表到复制含12那行"
 *
 * 默认 importDir = <quest-guide>/imports/pagewalk/<cardId>
 * 默认 quest-guide-dir = 仓库内 quest-guide/
 *
 * 行为：解析 Pagewalk 导出（HTML/MD + 截图）→ 生成 standalone walkthrough HTML
 * 到 media/ → 拷截图 → 合并进 card.json 的 guide.walkthrough / guide.media
 * （严格对齐 feat/quest-walkthrough-html 的 schema，不另起字段）。
 */
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { importPagewalk } from '../lib/host/pagewalk-import.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(HERE, '..')

function usage() {
  process.stdout.write(`用法: node bin/pagewalk-import.mjs <cardId> [importDir] [--caption "..."] [--dry-run] [--quest-guide-dir <dir>]\n`)
}

function main(argv) {
  const positional = []
  let caption
  let dryRun = false
  let questGuideDir = join(repoRoot, 'quest-guide')

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--caption') { caption = argv[++i]; }
    else if (a === '--dry-run') { dryRun = true; }
    else if (a === '--quest-guide-dir') { questGuideDir = resolve(argv[++i]); }
    else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else positional.push(a)
  }

  if (positional.length === 0) {
    process.stderr.write('缺少 cardId\n')
    usage()
    process.exit(2)
  }

  const [cardId, importDirArg] = positional
  const importDir = importDirArg
    ? resolve(importDirArg)
    : join(questGuideDir, 'imports', 'pagewalk', cardId)

  try {
    const result = importPagewalk({ importDir, questGuideDir, cardId, caption, dryRun })
    if (dryRun) {
      process.stdout.write(`[dry-run] walkthrough: ${JSON.stringify(result.walkthrough)}\n`)
      process.stdout.write(`[dry-run] media: ${JSON.stringify(result.media, null, 2)}\n`)
      return
    }
    process.stdout.write(`OK 已导入 Pagewalk → card ${cardId}\n`)
    process.stdout.write(`  walkthrough: ${result.walkthrough ? result.walkthrough.html : '(无)'}\n`)
    process.stdout.write(`  media 条目: ${result.media.length}\n`)
    process.stdout.write(`  card.json: ${result.cardPath}\n`)
    process.stdout.write(`  写入文件:\n    ${result.written.join('\n    ')}\n`)
  } catch (error) {
    process.stderr.write(`导入失败: ${error.message}\n`)
    process.exit(1)
  }
}

main(process.argv.slice(2))
