import { describe, expect, test } from "bun:test"
import { allocateSlot, missingTapAddrs, networkForSlot, slotAddress, slotCid, slotTap } from "./network"

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

describe("tap_addrs resync", () => {
  const listing = (elements: readonly (readonly [string, string])[] | null): string =>
    JSON.stringify({
      nftables: [
        { metainfo: { version: "1.1.7" } },
        {
          set: {
            family: "inet",
            name: "tap_addrs",
            table: "kestrel",
            type: ["ifname", "ipv4_addr"],
            handle: 1,
            ...(elements === null ? {} : { elem: elements.map(([tap, address]) => ({ concat: [tap, address] })) }),
          },
        },
      ],
    })
  const live = [networkForSlot(2), networkForSlot(3)]

  test("re-adds only the live taps the set lost", () => {
    const missing = missingTapAddrs(listing([["kn-2", "10.77.0.2"]]), live)
    expect(missing.map((network) => network.tap)).toEqual(["kn-3"])
  })

  test("an empty set, with or without an elem field, lists every live tap as missing", () => {
    expect(missingTapAddrs(listing(null), live).map((network) => network.tap)).toEqual(["kn-2", "kn-3"])
    expect(missingTapAddrs(listing([]), live).map((network) => network.tap)).toEqual(["kn-2", "kn-3"])
  })

  test("an element for the same tap at another address does not cover the live tap", () => {
    const missing = missingTapAddrs(listing([["kn-2", "10.77.0.9"]]), [networkForSlot(2)])
    expect(missing.map((network) => network.tap)).toEqual(["kn-2"])
  })

  test("refuses a listing it cannot read rather than guessing which taps are covered", () => {
    expect(() => missingTapAddrs('{"nftables":[{"set":{"elem":[{"prefix":{}}]}}]}', live)).toThrow()
  })
})
