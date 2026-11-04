import { describe, expect, test } from "bun:test"
import { FrameTooLongError, LineFramer } from "./vsock"

describe("guest frame framing", () => {
  test("a line split across reads is returned whole, with no partial line leaking out", () => {
    const framer = new LineFramer(64)
    expect(framer.push(Buffer.from('{"a":'))).toEqual([])
    expect(framer.push(Buffer.from('1}\n{"b":2}\n'))).toEqual(['{"a":1}', '{"b":2}'])
  })

  test("a line at the cap is accepted; one byte over is refused", () => {
    expect(new LineFramer(4).push(Buffer.from("abcd\n"))).toEqual(["abcd"])
    expect(() => new LineFramer(4).push(Buffer.from("abcde\n"))).toThrow(FrameTooLongError)
  })

  test("an unterminated line over the cap is refused before its newline arrives", () => {
    expect(() => new LineFramer(4).push(Buffer.from("abcde"))).toThrow(FrameTooLongError)
  })
})
