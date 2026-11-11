import { describe, expect, test } from "bun:test"
import type { NestHostCapacity, NestVmReport } from "@cloudagents/protocol"
import {
  DEFAULT_NEST_RATES,
  decideVm,
  enrollTokenHash,
  estimateNestCost,
  nestLimitsError,
  nestStatusOf,
  newSecret,
  parseNestRates,
  placeHost,
  publicUrlFor,
  withNestEstimate,
  type PlacementCandidate,
} from "./nest-control"
import type { NestBoxRow } from "./nest-table"

const GiB = 1024 * 1024 * 1024

const host = (hostId: string, freeGiB: number, diskFreeGiB = 10): PlacementCandidate => {
  const capacity: NestHostCapacity = {
    vcpus: 8,
    vcpusPlugged: 0,
    memoryBytes: 16 * GiB,
    memoryPluggedBytes: 16 * GiB - freeGiB * GiB,
    diskFreeBytes: diskFreeGiB * GiB,
    diskReservedBytes: 0,
    gpus: [],
    running: 0,
    suspended: 0,
  }
  return { hostId, slug: `slug-${hostId}`, capacity }
}

const row = (overrides: Partial<NestBoxRow> = {}): NestBoxRow => ({
  boxId: "box-1",
  login: "alice",
  hostId: "host-a",
  vmId: "vm-1",
  ownerEpoch: 2,
  state: "running",
  limits: { maxVcpus: 4, maxMemoryBytes: 8 * GiB, gpu: "none", volumeBytes: 64 * GiB },
  volumeRef: null,
  backedUpAt: null,
  imageId: "image-1",
  vcpus: 4,
  memoryBytes: 8 * GiB,
  gpus: 0,
  wakeWanted: false,
  enrollHash: null,
  enrollExpiresAt: null,
  pendingId: null,
  pendingKind: null,
  pendingCommand: null,
  pendingDeadline: null,
  ...overrides,
})

const report = (overrides: Partial<NestVmReport> = {}): NestVmReport => ({
  boxId: "box-1",
  vmId: "vm-1",
  userId: "alice",
  ownerEpoch: 2,
  state: "running",
  since: 0,
  imageId: "image-1",
  vcpus: 4,
  memoryBytes: 8 * GiB,
  gpus: [],
  diskBytes: 0,
  volumeRef: null,
  backedUpAt: null,
  limits: { maxVcpus: 4, maxMemoryBytes: 8 * GiB, gpu: "none", volumeBytes: 64 * GiB },
  ...overrides,
})

describe("placeHost", () => {
  test("picks the connected host with the most free memory", () => {
    expect(placeHost([host("a", 2), host("b", 6), host("c", 4)])?.hostId).toBe("b")
  })

  test("breaks a tie toward the lower host id, whatever the order", () => {
    expect(placeHost([host("b", 4), host("a", 4)])?.hostId).toBe("a")
  })

  test("skips a host without memory for a booting VM plus headroom, or without disk for its memory image", () => {
    expect(placeHost([host("a", 1.4)])).toBeNull()
    expect(placeHost([host("a", 6, 0.5)])).toBeNull()
    expect(placeHost([host("a", 1.4), host("b", 3)])?.hostId).toBe("b")
  })

  test("returns null when no host is connected", () => {
    expect(placeHost([])).toBeNull()
  })

  test("takes the preferred host whenever it has room, even with less free memory than another", () => {
    expect(placeHost([host("a", 2), host("b", 6)], "a")?.hostId).toBe("a")
  })

  test("falls back to the most-free host when the preferred host lacks room or is not connected", () => {
    expect(placeHost([host("a", 1.4), host("b", 3)], "a")?.hostId).toBe("b")
    expect(placeHost([host("b", 3)], "a")?.hostId).toBe("b")
  })
})

describe("decideVm", () => {
  test("ignores a report for a box the control plane does not know", () => {
    expect(decideVm(null, "host-a", report())._tag).toBe("ignore")
  })

  test("evicts a copy at a lower epoch than the box's", () => {
    expect(decideVm(row({ ownerEpoch: 3 }), "host-a", report({ ownerEpoch: 2 }))).toEqual({ _tag: "evict" })
  })

  test("ignores a copy at a higher epoch than the control plane has recorded", () => {
    expect(decideVm(row({ ownerEpoch: 2 }), "host-a", report({ ownerEpoch: 3 }))._tag).toBe("ignore")
  })

  test("ignores a same-epoch copy on a host other than the box's", () => {
    expect(decideVm(row({ hostId: "host-b" }), "host-a", report())._tag).toBe("ignore")
  })

  test("ignores a same-epoch copy of a different VM incarnation", () => {
    expect(decideVm(row(), "host-a", report({ vmId: "vm-other" }))._tag).toBe("ignore")
  })

  test("applies the report of the current placement", () => {
    expect(decideVm(row(), "host-a", report())).toEqual({ _tag: "apply" })
  })
})

describe("nestStatusOf", () => {
  test("does not show a create or evict as pending, but shows other commands", () => {
    expect(nestStatusOf(row({ pendingKind: "create" })).pending).toBeNull()
    expect(nestStatusOf(row({ pendingKind: "resume" })).pending).toBe("resume")
    expect(nestStatusOf(row({ pendingKind: null })).pending).toBeNull()
  })

  test("reports the box's state, limits, and size", () => {
    const status = nestStatusOf(row({ state: "suspended", vcpus: 0, memoryBytes: 0, gpus: 1 }))
    expect(status).toEqual({
      state: "suspended",
      pending: null,
      limits: { maxVcpus: 4, maxMemoryBytes: 8 * GiB, gpu: "none", volumeBytes: 64 * GiB },
      vcpus: 0,
      memoryBytes: 0,
      gpus: 1,
    })
  })
})

describe("nestLimitsError", () => {
  const limits = { maxVcpus: 2, maxMemoryBytes: GiB, gpu: "none" as const, volumeBytes: GiB }

  test("refuses a memory ceiling too small to boot the VM", () => {
    expect(nestLimitsError({ ...limits, maxMemoryBytes: GiB - 1 })).not.toBeNull()
  })

  test("accepts a memory ceiling of exactly one GiB", () => {
    expect(nestLimitsError(limits)).toBeNull()
  })
})

describe("publicUrlFor", () => {
  test("is the box id under the host's slug under the Nest domain", () => {
    expect(publicUrlFor("box-1", "host-a", "nest.example.com")).toBe("https://box-1.host-a.nest.example.com")
  })
})

describe("estimateNestCost", () => {
  const limits = { maxVcpus: 4, maxMemoryBytes: 8 * GiB, gpu: "none" as const, volumeBytes: 64 * GiB }

  test("prices the standard shape at its limits", () => {
    const estimate = estimateNestCost(limits, DEFAULT_NEST_RATES)
    expect(estimate.currency).toBe("USD")
    expect(estimate.hourlyRunning).toBeCloseTo(0.328, 6)
    expect(estimate.monthlyRunning).toBeCloseTo(245.84, 6)
    expect(estimate.monthlyParked).toBeCloseTo(2.56, 6)
  })

  test("adds the GPU rate only for a shape that allows one", () => {
    expect(estimateNestCost({ ...limits, gpu: "on-demand" }, DEFAULT_NEST_RATES).hourlyRunning).toBeCloseTo(1.528, 6)
    expect(estimateNestCost({ ...limits, gpu: "none" }, DEFAULT_NEST_RATES).hourlyRunning).toBeCloseTo(0.328, 6)
  })

  test("scales with CPU, memory and volume", () => {
    const small = estimateNestCost(
      { maxVcpus: 1, maxMemoryBytes: GiB, gpu: "none", volumeBytes: 8 * GiB },
      DEFAULT_NEST_RATES,
    )
    expect(small.hourlyRunning).toBeCloseTo(0.066, 6)
    expect(small.monthlyParked).toBeCloseTo(0.32, 6)
  })
})

describe("parseNestRates", () => {
  test("uses the defaults when unset or empty", () => {
    expect(parseNestRates(undefined)).toEqual(DEFAULT_NEST_RATES)
    expect(parseNestRates("   ")).toEqual(DEFAULT_NEST_RATES)
  })

  test("reads an operator's card", () => {
    const card = {
      currency: "EUR",
      vcpuHour: 1,
      memoryGiBHour: 2,
      gpuHour: 3,
      diskGiBMonth: 4,
      parkedDiskGiBMonth: 5,
    }
    expect(parseNestRates(JSON.stringify(card))).toEqual(card)
  })

  test("turns a malformed or negative card into no card, rather than failing", () => {
    expect(parseNestRates("{")).toBeNull()
    expect(parseNestRates(JSON.stringify({ ...DEFAULT_NEST_RATES, vcpuHour: -1 }))).toBeNull()
    expect(parseNestRates(JSON.stringify({ ...DEFAULT_NEST_RATES, extra: 1 }))).toBeNull()
  })
})

describe("withNestEstimate", () => {
  test("leaves a status alone when the operator has no rate card", () => {
    const status = nestStatusOf(row())
    expect(withNestEstimate(status, null)).toBe(status)
  })

  test("adds the shape's estimate when rates exist", () => {
    const status = withNestEstimate(nestStatusOf(row()), DEFAULT_NEST_RATES)
    expect(status.estimate?.monthlyRunning).toBeCloseTo(245.84, 6)
  })
})

describe("enrollment tokens", () => {
  test("are 43 base64url characters and differ on every call", () => {
    const first = newSecret()
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newSecret()).not.toBe(first)
  })

  test("hash deterministically, and the hash is not the token", async () => {
    const token = newSecret()
    const hash = await enrollTokenHash(token)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toBe(token)
    expect(await enrollTokenHash(token)).toBe(hash)
  })
})
