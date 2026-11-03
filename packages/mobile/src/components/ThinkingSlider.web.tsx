import React from "react";
import type { ThinkingSliderProps } from "./ThinkingSlider";

/** Preserve browser range keyboard, pointer, touch and screen-reader semantics. */
export function ThinkingSlider({ value, max, label, onChange, onFocusChange }: ThinkingSliderProps) {
  return (
    <>
      <style>{`
        .thinking-range::-webkit-slider-thumb { appearance: none; width: 32px; height: 44px; }
        .thinking-range::-moz-range-thumb { width: 32px; height: 44px; border: 0; }
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
        autoFocus
        onFocus={() => onFocusChange(true)}
        onBlur={() => onFocusChange(false)}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", margin: 0, padding: 0, appearance: "none", opacity: 0, cursor: "pointer" }}
      />
    </>
  );
}
