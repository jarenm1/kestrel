import { describe, expect, test } from "bun:test"
import { allocateSlot, slotAddress, slotCid, slotTap } from "./network"

describe("slot allocation", () => {
  test("hands out the lowest free slot, skipping reserved and used ones", () => {
    expect(allocateSlot(new Set())).toBe(2)
    expect(allocateSlot(new Set([2, 3, 5]))).toBe(4)
  })

  test("a slot maps to one address, one tap and one vsock cid", () => {
    expect(slotAddress(2)).toBe("10.77.0.2")
    expect(slotAddress(300)).toBe("10.77.1.44")
    expect(slotTap(300)).toBe("kn-300")
    expect(slotCid(300)).toBe(302)
  })

  test("refuses when every slot is in use", () => {
    const used = new Set<number>()
    for (let slot = 2; slot <= 65533; slot += 1) used.add(slot)
    expect(() => allocateSlot(used)).toThrow("no free network slot")
  })
})
