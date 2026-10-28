import { describe, expect, test } from "bun:test"
import { inflateSync } from "node:zlib"
import { type RgbFrame, changedRegions, encodePng, resample } from "./frames"

const solid = (width: number, height: number, value: number): RgbFrame => ({
  width,
  height,
  pixels: new Uint8Array(width * height * 3).fill(value),
})

describe("changedRegions", () => {
  test("identical frames have no changed regions", () => {
    expect(changedRegions(solid(64, 48, 7), solid(64, 48, 7), { x: 0, y: 0, width: 64, height: 48 })).toEqual([])
  })

  test("one changed pixel becomes one padded box", () => {
    const before = solid(200, 100, 0)
    const after = solid(200, 100, 0)
    after.pixels[(40 * 200 + 90) * 3] = 255
    expect(changedRegions(before, after, { x: 0, y: 0, width: 200, height: 100 })).toEqual([
      { x: 72, y: 24, width: 32, height: 32 },
    ])
  })

  test("changes outside the area are ignored", () => {
    const before = solid(200, 100, 0)
    const after = solid(200, 100, 0)
    after.pixels[(40 * 200 + 150) * 3] = 255
    expect(changedRegions(before, after, { x: 0, y: 0, width: 100, height: 100 })).toEqual([])
  })

  test("distant changes are capped at three boxes", () => {
    const before = solid(400, 40, 0)
    const after = solid(400, 40, 0)
    for (const x of [10, 100, 190, 280, 370]) after.pixels[(20 * 400 + x) * 3] = 255
    const boxes = changedRegions(before, after, { x: 0, y: 0, width: 400, height: 40 })
    expect(boxes.length).toBe(3)
    for (const box of boxes) expect(box.x + box.width).toBeLessThanOrEqual(400)
  })
})

describe("resample", () => {
  test("halving a solid area keeps its colour", () => {
    const out = resample(solid(40, 40, 90), { x: 0, y: 0, width: 40, height: 40 }, 0.5)
    expect(out.width).toBe(20)
    expect(out.height).toBe(20)
    expect(out.pixels.every((v) => v === 90)).toBe(true)
  })

  test("crops before scaling", () => {
    const frame = solid(40, 40, 0)
    for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) frame.pixels.fill(200, (y * 40 + x) * 3, (y * 40 + x) * 3 + 3)
    const out = resample(frame, { x: 10, y: 10, width: 10, height: 10 }, 1)
    expect(out.width).toBe(10)
    expect(out.pixels.every((v) => v === 200)).toBe(true)
  })
})

describe("encodePng", () => {
  test("writes a valid RGB PNG whose IDAT inflates to filtered rows", () => {
    const png = encodePng(solid(3, 2, 255))
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(png.readUInt32BE(16)).toBe(3)
    expect(png.readUInt32BE(20)).toBe(2)
    expect(png[24]).toBe(8)
    expect(png[25]).toBe(2)
    // IHDR chunk ends at 33; the IDAT chunk follows.
    const length = png.readUInt32BE(33)
    expect(png.subarray(37, 41).toString("latin1")).toBe("IDAT")
    expect(inflateSync(png.subarray(41, 41 + length)).length).toBe((3 * 3 + 1) * 2)
  })
})
