import React, { useRef } from "react";
import { StyleSheet, View, type GestureResponderEvent } from "react-native";

export interface ThinkingSliderProps {
  readonly value: number;
  readonly max: number;
  readonly label: string;
  readonly onChange: (value: number) => void;
}

/** Transparent input over the shared track; native touch and VoiceOver/TalkBack adjustments. */
export function ThinkingSlider({ value, max, label, onChange }: ThinkingSliderProps) {
  const width = useRef(0);
  function select(event: GestureResponderEvent) {
    if (width.current <= 32) return;
    const next = Math.max(0, Math.min(max, Math.round((event.nativeEvent.locationX - 16) / (width.current - 32) * max)));
    if (next !== value) onChange(next);
  }
  return (
    <View
      style={StyleSheet.absoluteFill}
      onLayout={(event) => { width.current = event.nativeEvent.layout.width; }}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Thinking level"
      accessibilityValue={{ min: 0, max, now: value, text: label }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(event) => {
        const action = event.nativeEvent.actionName;
        if (action === "increment") onChange(Math.min(max, value + 1));
        if (action === "decrement") onChange(Math.max(0, value - 1));
      }}
      onStartShouldSetResponder={() => true}
      onResponderGrant={select}
      onResponderMove={select}
      onResponderTerminationRequest={() => false}
    />
  );
}
