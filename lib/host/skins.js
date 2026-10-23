/**
 * Skin registry — four built-in palettes drawn by the client from one SVG
 * (no third-party art is redistributed), plus user-imported spritesheet
 * atlases stored as PNG + JSON under `<dshHome>/pet-one/skins/`.
 * @module dsh-pet-one/host/skins
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { petOneDir } from './home.js'

/** Built-in skins: same rig, different palettes. */
export const BUILTIN_SKINS = [
  {
    id: 'whale',
    name: '小鲸（默认）',
    kind: 'palette',
    palette: {
      body: '#4b7bec',
      bodyDark: '#3867d6',
      belly: '#dbe7ff',
      hair: '#1f2d4d',
      accent: '#7fe3ff',
      blush: '#ff9aa2',
    },
  },
  {
    id: 'sakura',
    name: '樱花鲸',
    kind: 'palette',
    palette: {
      body: '#ff8fb1',
      bodyDark: '#e5679a',
      belly: '#ffe6ee',
      hair: '#6b2c46',
      accent: '#ffd6e7',
      blush: '#ff5d8f',
    },
  },
  {
    id: 'midnight',
    name: '午夜鲸',
    kind: 'palette',
    palette: {
      body: '#2f3a6b',
      bodyDark: '#1f2748',
      belly: '#aebcff',
      hair: '#0b1024',
      accent: '#8b9bff',
      blush: '#7c5cff',
    },
  },
  {
    id: 'ghost',
    name: '幽灵鲸',
    kind: 'palette',
    palette: {
      body: '#c9f2ea',
      bodyDark: '#9cded2',
      belly: '#f4fffd',
      hair: '#2f5d57',
      accent: '#ffffff',
      blush: '#ffb3c1',
    },
  },
]

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/
const MAX_ATLAS_BYTES = 12 * 1024 * 1024
const MIME_BY_EXT = { png: 'image/png', webp: 'image/webp', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg' }

/** Directory holding imported atlases. */
export function skinsDir(env = process.env) {
  return join(petOneDir(env), 'skins')
}

/** Read imported atlas metadata (tolerant). */
function readImported(dir) {
  try {
    const file = join(dir, 'index.json')
    if (!existsSync(file)) return []
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry) => entry && typeof entry.id === 'string' && ID_PATTERN.test(entry.id))
  } catch {
    return []
  }
}

/** Write imported atlas metadata. */
function writeImported(dir, entries) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.json'), JSON.stringify(entries, null, 2) + '\n', 'utf8')
}

/**
 * Build the skin registry used by routes and the state view.
 * @param {{env?: NodeJS.ProcessEnv, dir?: string}} [options]
 */
export function createSkinRegistry(options = {}) {
  const env = options.env ?? process.env
  const dir = options.dir ?? skinsDir(env)

  function list() {
    const imported = readImported(dir).map((entry) => ({
      id: entry.id,
      name: entry.name || entry.id,
      kind: 'atlas',
      image: `/api/pet-one/skins/${entry.id}/image`,
      cols: entry.cols,
      rows: entry.rows,
      fps: entry.fps,
      frameRow: entry.frameRow ?? null,
    }))
    return [...BUILTIN_SKINS, ...imported]
  }

  /** Resolve one skin descriptor (built-in or imported). */
  function get(id) {
    return list().find((skin) => skin.id === id) ?? null
  }

  /** Absolute file path of an imported atlas image. */
  function imagePath(id) {
    if (!ID_PATTERN.test(String(id))) return null
    const entry = readImported(dir).find((candidate) => candidate.id === id)
    if (entry === undefined) return null
    const file = join(dir, entry.file)
    return existsSync(file) ? { file, mime: MIME_BY_EXT[entry.ext] ?? 'image/png' } : null
  }

  /**
   * Import a spritesheet data URL.
   * @param {{name?: string, id?: string, dataUrl: string, cols?: number, rows?: number, fps?: number, frameRow?: number}} input
   */
  function importAtlas(input) {
    const dataUrl = typeof input?.dataUrl === 'string' ? input.dataUrl : ''
    const match = /^data:(image\/(?:png|webp|gif|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
    if (match === null) throw new Error('只支持 PNG/WebP/GIF/JPEG 的 base64 data URL')
    const mime = match[1]
    const buffer = Buffer.from(match[2], 'base64')
    if (buffer.byteLength > MAX_ATLAS_BYTES) throw new Error('图片超过 12MB')
    const ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]
    const id = typeof input.id === 'string' && ID_PATTERN.test(input.id)
      ? input.id
      : `atlas-${Date.now().toString(36)}`
    const cols = clampInt(input.cols, 1, 32, 8)
    const rows = clampInt(input.rows, 1, 32, 9)
    const fps = clampInt(input.fps, 1, 24, 6)
    mkdirSync(dir, { recursive: true })
    const file = `${id}.${ext}`
    writeFileSync(join(dir, file), buffer)
    const entries = readImported(dir).filter((entry) => entry.id !== id)
    entries.push({
      id,
      name: typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim().slice(0, 40) : '导入精灵图',
      file,
      ext,
      cols,
      rows,
      fps,
      frameRow: Number.isInteger(input.frameRow) ? input.frameRow : null,
      bytes: buffer.byteLength,
      at: Date.now(),
    })
    writeImported(dir, entries)
    return get(id)
  }

  /** Remove one imported atlas. */
  function removeAtlas(id) {
    if (!ID_PATTERN.test(String(id))) return false
    const entries = readImported(dir)
    const next = entries.filter((entry) => entry.id !== id)
    if (next.length === entries.length) return false
    writeImported(dir, next)
    return true
  }

  return { list, get, imagePath, importAtlas, removeAtlas }
}

/** Clamp an integer input into [min, max] with a fallback. */
function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
