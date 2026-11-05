import { describe, expect, test } from "bun:test";
import { thinkingFillWidth, thinkingStopOffsets } from "./thinking";

describe("thinkingStopOffsets", () => {
  test("two levels sit at the thumb insets", () => {
    expect(thinkingStopOffsets(2, 200)).toEqual([16, 184]);
  });

  test("three levels are evenly spaced between the insets", () => {
    expect(thinkingStopOffsets(3, 232)).toEqual([16, 116, 216]);
  });

  test("a single level centers its thumb instead of dividing by zero", () => {
    expect(thinkingStopOffsets(1, 200)).toEqual([100]);
    expect(thinkingStopOffsets(1, 0)).toEqual([16]);
    expect(thinkingStopOffsets(1, 20)).toEqual([16]);
  });

  test("no levels have no stops", () => {
    expect(thinkingStopOffsets(0, 200)).toEqual([]);
  });
});

describe("thinkingFillWidth", () => {
  test("the selected stop is half a thumb into the track", () => {
    expect(thinkingFillWidth(2, 200, 0)).toBe(24);
    expect(thinkingFillWidth(2, 200, 1)).toBe(192);
  });

  test("a single level fills the track", () => {
    expect(thinkingFillWidth(1, 200, 0)).toBe(192);
    expect(thinkingFillWidth(1, 4, 0)).toBe(0);
  });
});
