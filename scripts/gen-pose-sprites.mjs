/**
 * Generate placeholder pose sprite frames for the desktop pet.
 *
 * Convention (see docs/pet-pose.md):
 *   desktop/assets/sprites/<skin>/<pose>/frameN.png
 *
 * Each frame is a solid, distinctively-coloured square (the brief permits
 * pure-colour / simple sketch placeholders). A real artist later drops in
 * actual sequence frames at the same path and they are served as-is by the
 * `/api/pet-one/sprites/<skin>/<pose>/<frame>.png` route — no code change.
 *
 * @module dsh-pet-one/scripts/gen-pose-sprites
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'assets', 'sprites')
const SIZE = 96

const POSES = {
  idle: [75, 123, 236], // blue
  working: [46, 204, 113], // green
  celebrate: [255, 177, 66], // orange
  slack: [155, 89, 182], // purple
  pet: [255, 107, 129], // pink
  drag: [0, 206, 201], // teal
}

/** CRC32 (IEEE) for PNG chunk checksums. */
function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (~c) >>> 0
}

/** Wrap one PNG chunk. */
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

/** Build a single solid-colour RGBA PNG. */
function makePng(size, [r, g, b]) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    const off = y * (size * 4 + 1)
    raw[off] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const p = off + 1 + x * 4
      raw[p] = r
      raw[p + 1] = g
      raw[p + 2] = b
      raw[p + 3] = 255
    }
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const skin = process.argv[2] || 'whale'
for (const [pose, color] of Object.entries(POSES)) {
  const dir = join(root, skin, pose)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'frame0.png'), makePng(SIZE, color))
  console.log(`wrote ${join(dir, 'frame0.png')}`)
}
