import { describe, expect, test } from "bun:test"
import { defaultMemoryHigh, type Provisioning, type SystemdSettings, taskProperties } from "./systemd"

const settings = (provisioning: Provisioning): SystemdSettings => ({
  boxSlice: "kestrel-box",
  provisioning,
  limits: {
    memoryMin: "1G",
    cpuWeight: 100,
    memoryMax: "4G",
    memoryHigh: "3865470566",
    swapMax: "1G",
    cpuQuota: "200%",
    tasksMax: "1024",
  },
  box: { memoryMax: "infinity", swapMax: "8G", cpuQuota: "800%" },
})

const property = (properties: string[], key: string) =>
  properties.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1)

describe("per-thread task limits", () => {
  test("cap memory at MemoryMax, throttle from MemoryHigh, and allow only the configured swap", () => {
    const properties = taskProperties(settings("per-thread"))
    expect(property(properties, "MemoryMax")).toBe("4G")
    expect(property(properties, "MemoryHigh")).toBe("3865470566")
    expect(property(properties, "MemorySwapMax")).toBe("1G")
    expect(property(properties, "CPUQuota")).toBe("200%")
  })

  test("other modes clear the per-thread caps so a slice made earlier cannot keep them", () => {
    for (const provisioning of ["guaranteed", "pooled"] as const) {
      const properties = taskProperties(settings(provisioning))
      expect(property(properties, "MemoryMax")).toBe("infinity")
      expect(property(properties, "MemoryHigh")).toBe("infinity")
      expect(property(properties, "MemorySwapMax")).toBe("infinity")
      expect(property(properties, "CPUQuota")).toBe("")
    }
  })
})

describe("defaultMemoryHigh", () => {
  test("is 90% of a byte MemoryMax", () => {
    expect(defaultMemoryHigh("4G")).toBe(String(Math.floor(4 * 1024 ** 3 * 0.9)))
  })

  test("is 90% of a percentage MemoryMax", () => {
    expect(defaultMemoryHigh("50%")).toBe("45%")
  })

  test("stays infinity when MemoryMax is infinity", () => {
    expect(defaultMemoryHigh("infinity")).toBe("infinity")
  })
})
