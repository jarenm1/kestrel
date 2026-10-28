import { crc32, deflateSync } from "node:zlib"
import type { DesktopRegion } from "./manager"

/** Raw RGB24 pixels, rows top to bottom, no padding: 3 bytes per pixel. */
export interface RgbFrame {
  readonly width: number
  readonly height: number
  readonly pixels: Uint8Array
}

/** Long edge of a default view: ~1.3k image tokens (width x height / 750), about what models view without resizing. */
export const OVERVIEW_EDGE = 1280
/** Changed regions are merged into at most this many boxes. */
export const MAX_CHANGE_BOXES = 3

/** Changes are found per tile; a tile is changed when any of its pixels differs. */
const TILE = 16
/** Context around each changed box, in desktop pixels. */
const CHANGE_PAD = 8
/** Boxes this close (Chebyshev distance, desktop pixels) merge into one. */
const CHANGE_MERGE_GAP = 32

/** Scale that fits the region's long edge into OVERVIEW_EDGE. Never enlarges. */
export const defaultScale = (area: DesktopRegion): number =>
  Math.min(1, OVERVIEW_EDGE / Math.max(area.width, area.height))

/** For each output sample, the first source sample it covers and the weights of the source samples it overlaps. */
interface Taps {
  readonly first: number
  readonly weights: Float64Array
}

/** Area-weighted taps: each output sample averages the source span it covers (a box filter when shrinking). */
const taps = (srcLen: number, dstLen: number): Taps[] => {
  const ratio = srcLen / dstLen
  return Array.from({ length: dstLen }, (_, i) => {
    const a = i * ratio
    const b = (i + 1) * ratio
    const first = Math.floor(a)
    const last = Math.min(srcLen, Math.ceil(b))
    const weights = new Float64Array(last - first)
    for (let j = first; j < last; j++) weights[j - first] = (Math.min(b, j + 1) - Math.max(a, j)) / ratio
    return { first, weights }
  })
}

/** Crops `area` of the frame and resizes it by `scale`, area-weighted so small text stays readable. */
export const resample = (frame: RgbFrame, area: DesktopRegion, scale: number): RgbFrame => {
  const width = Math.max(1, Math.round(area.width * scale))
  const height = Math.max(1, Math.round(area.height * scale))
  const xs = taps(area.width, width)
  const ys = taps(area.height, height)
  const rowLen = width * 3
  // Horizontal pass over the area's rows, so the vertical pass reads resized rows.
  const mid = new Float32Array(area.height * rowLen)
  for (let y = 0; y < area.height; y++) {
    const srcRow = (area.y + y) * frame.width + area.x
    for (let x = 0; x < width; x++) {
      const { first, weights } = xs[x] as Taps
      for (let c = 0; c < 3; c++) {
        let sum = 0
        for (let k = 0; k < weights.length; k++) sum += (weights[k] as number) * (frame.pixels[(srcRow + first + k) * 3 + c] as number)
        mid[y * rowLen + x * 3 + c] = sum
      }
    }
  }
  const out = new Uint8Array(height * rowLen)
  for (let y = 0; y < height; y++) {
    const { first, weights } = ys[y] as Taps
    for (let i = 0; i < rowLen; i++) {
      let sum = 0
      for (let k = 0; k < weights.length; k++) sum += (weights[k] as number) * (mid[(first + k) * rowLen + i] as number)
      out[y * rowLen + i] = Math.round(sum)
    }
  }
  return { width, height, pixels: out }
}

interface Box {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

const area = (b: Box) => (b.x1 - b.x0) * (b.y1 - b.y0)
const union = (a: Box, b: Box): Box => ({
  x0: Math.min(a.x0, b.x0),
  y0: Math.min(a.y0, b.y0),
  x1: Math.max(a.x1, b.x1),
  y1: Math.max(a.y1, b.y1),
})

/** Merges until no two boxes are within CHANGE_MERGE_GAP, then until at most MAX_CHANGE_BOXES remain. */
const mergeBoxes = (boxes: Box[]): Box[] => {
  let list = boxes
  for (let merged = true; merged; ) {
    merged = false
    search: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i] as Box
        const b = list[j] as Box
        if (Math.max(0, b.x0 - a.x1, a.x0 - b.x1, b.y0 - a.y1, a.y0 - b.y1) > CHANGE_MERGE_GAP) continue
        list = list.filter((_, k) => k !== i && k !== j).concat(union(a, b))
        merged = true
        break search
      }
    }
  }
  while (list.length > MAX_CHANGE_BOXES) {
    // The pair whose union adds the least empty area.
    let best = { i: 0, j: 1, waste: Number.POSITIVE_INFINITY }
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i] as Box
        const b = list[j] as Box
        const waste = area(union(a, b)) - area(a) - area(b)
        if (waste < best.waste) best = { i, j, waste }
      }
    }
    const merged = union(list[best.i] as Box, list[best.j] as Box)
    list = list.filter((_, k) => k !== best.i && k !== best.j).concat(merged)
  }
  return list
}

/**
 * Bounding boxes, in desktop pixels, of the pixels inside `within` that differ between two frames of the same size.
 * Changed tiles are grouped into 8-connected clusters, padded, merged, and capped at MAX_CHANGE_BOXES.
 */
export const changedRegions = (before: RgbFrame, after: RgbFrame, within: DesktopRegion): DesktopRegion[] => {
  const cols = Math.ceil(within.width / TILE)
  const rows = Math.ceil(within.height / TILE)
  const changed = new Uint8Array(cols * rows)
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const yEnd = Math.min(within.height, (ty + 1) * TILE)
      const xEnd = Math.min(within.width, (tx + 1) * TILE)
      tile: for (let y = ty * TILE; y < yEnd; y++) {
        const row = (within.y + y) * before.width
        for (let x = tx * TILE; x < xEnd; x++) {
          const p = (row + within.x + x) * 3
          if (
            before.pixels[p] !== after.pixels[p] ||
            before.pixels[p + 1] !== after.pixels[p + 1] ||
            before.pixels[p + 2] !== after.pixels[p + 2]
          ) {
            changed[ty * cols + tx] = 1
            break tile
          }
        }
      }
    }
  }

  const seen = new Uint8Array(cols * rows)
  const clusters: Box[] = []
  for (let start = 0; start < changed.length; start++) {
    if (changed[start] === 0 || seen[start] === 1) continue
    let minTx = cols, minTy = rows, maxTx = -1, maxTy = -1
    const stack = [start]
    seen[start] = 1
    while (stack.length > 0) {
      const at = stack.pop() as number
      const tx = at % cols
      const ty = Math.floor(at / cols)
      minTx = Math.min(minTx, tx)
      maxTx = Math.max(maxTx, tx)
      minTy = Math.min(minTy, ty)
      maxTy = Math.max(maxTy, ty)
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = tx + dx
          const ny = ty + dy
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
          const n = ny * cols + nx
          if (changed[n] === 1 && seen[n] === 0) {
            seen[n] = 1
            stack.push(n)
          }
        }
      }
    }
    clusters.push({
      x0: within.x + minTx * TILE,
      y0: within.y + minTy * TILE,
      x1: within.x + Math.min(within.width, (maxTx + 1) * TILE),
      y1: within.y + Math.min(within.height, (maxTy + 1) * TILE),
    })
  }

  const withinX1 = within.x + within.width
  const withinY1 = within.y + within.height
  return mergeBoxes(clusters)
    .map((b) => ({
      x0: Math.max(within.x, b.x0 - CHANGE_PAD),
      y0: Math.max(within.y, b.y0 - CHANGE_PAD),
      x1: Math.min(withinX1, b.x1 + CHANGE_PAD),
      y1: Math.min(withinY1, b.y1 + CHANGE_PAD),
    }))
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
    .map((b) => ({ x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0 }))
}

const chunk = (type: string, data: Uint8Array): Buffer => {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, "latin1")
  out.set(data, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 8-bit RGB PNG, filter None on every row. */
export const encodePng = (frame: RgbFrame): Buffer => {
  const stride = frame.width * 3
  const raw = Buffer.alloc((stride + 1) * frame.height)
  for (let y = 0; y < frame.height; y++) {
    raw.set(frame.pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(frame.width, 0)
  header.writeUInt32BE(frame.height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // colour type: RGB
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}
