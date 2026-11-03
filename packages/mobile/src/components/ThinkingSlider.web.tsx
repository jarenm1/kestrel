import React from "react";
import type { ThinkingSliderProps } from "./ThinkingSlider";

/**
 * Preserve browser range keyboard, pointer, touch and screen-reader semantics. Nothing here takes focus on open:
 * the sheet's modal records the trigger as the element to restore, and Tab reaches the range as on desktop.
 */
export function ThinkingSlider({ value, max, label, onChange }: ThinkingSliderProps) {
  return (
    <>
      <style>{`
        .thinking-range::-webkit-slider-thumb { appearance: none; width: 32px; height: 44px; }
        .thinking-range::-moz-range-thumb { width: 32px; height: 44px; border: 0; }
        .thinking-range:focus { outline: none; }
      `}</style>
      <input
        className="thinking-range"
        type="range"
        aria-label="Thinking level"
        aria-valuetext={label}
        min={0}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", margin: 0, padding: 0, appearance: "none", opacity: 0, cursor: "pointer" }}
      />
    </>
  );
}
