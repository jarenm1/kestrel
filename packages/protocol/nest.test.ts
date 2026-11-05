import { describe, expect, test } from "bun:test"
import { Either, Schema } from "effect"
import {
  NEST_INVENTORY_CHUNK_VMS,
  NEST_MAX_VOLUME_BYTES,
  NEST_MIN_MEMORY_BYTES,
  NEST_MIN_VOLUME_BYTES,
  NestEnrollBody,
  NestLimits,
  decodeNestHostFrame,
} from "./src/nest"

const token = "a".repeat(43)
const limits = { maxVcpus: 2, maxMemoryBytes: 4 * 1024 ** 3, gpu: "none", volumeBytes: 10 * 1024 ** 3 }

describe("NestEnrollBody", () => {
  const decode = (value: string) => Schema.decodeUnknownEither(NestEnrollBody)({ boxId: "box_1", token: value })

  test("accepts a 43-character base64url token", () => {
    expect(Either.isRight(decode(token))).toBe(true)
  })

  test("rejects tokens that are not exactly 32 random bytes in base64url", () => {
    expect(Either.isLeft(decode("a".repeat(44)))).toBe(true)
    expect(Either.isLeft(decode("a".repeat(42)))).toBe(true)
    expect(Either.isLeft(decode(`${"a".repeat(42)}+`))).toBe(true)
  })
})

describe("NestLimits", () => {
  const decode = Schema.decodeUnknownEither(NestLimits)

  test("bounds memory and the volume size", () => {
    expect(Either.isRight(decode(limits))).toBe(true)
    expect(Either.isLeft(decode({ ...limits, maxMemoryBytes: NEST_MIN_MEMORY_BYTES - 1 }))).toBe(true)
    expect(Either.isLeft(decode({ ...limits, volumeBytes: NEST_MIN_VOLUME_BYTES - 1 }))).toBe(true)
    expect(Either.isLeft(decode({ ...limits, volumeBytes: NEST_MAX_VOLUME_BYTES + 1 }))).toBe(true)
  })
})

describe("NestHostFrame inventory", () => {
  const vm = {
    boxId: "box_1",
    vmId: "vm_1",
    userId: "user_1",
    ownerEpoch: 1,
    state: "running",
    since: 1,
    imageId: "image_1",
    vcpus: 1,
    memoryBytes: 1024,
    gpus: [],
    diskBytes: 0,
    volumeRef: null,
    backedUpAt: null,
    limits,
  }
  const chunk = (count: number) => JSON.stringify({ _tag: "inventory", vms: Array(count).fill(vm), last: true })

  test("accepts a one-VM chunk, so the fixture is a valid report", () => {
    expect(Either.isRight(decodeNestHostFrame(chunk(1)))).toBe(true)
  })

  test("rejects an inventory chunk over the chunk limit", () => {
    expect(Either.isLeft(decodeNestHostFrame(chunk(NEST_INVENTORY_CHUNK_VMS + 1)))).toBe(true)
  })
})
