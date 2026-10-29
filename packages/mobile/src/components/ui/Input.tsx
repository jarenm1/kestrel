import React, { useState } from "react";
import { StyleSheet, TextInput, type TextInputProps } from "react-native";
import { colors, radius } from "@/theme";

/** Single-line field, the web app's `Input` (`bg-input`, brighter while focused). */
export function Input({ style, onFocus, onBlur, ...props }: TextInputProps) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      placeholderTextColor={colors.mutedForeground + "b3"}
      {...props}
      onFocus={(e) => {
        setFocused(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        onBlur?.(e);
      }}
      style={[styles.input, focused && styles.focused, props.editable === false && styles.disabled, style]}
    />
  );
}

/** Multi-line field, the web app's `Textarea`. */
export function Textarea({ style, ...props }: TextInputProps) {
  return <Input multiline textAlignVertical="top" {...props} style={[styles.textarea, style]} />;
}

const styles = StyleSheet.create({
  input: {
    minHeight: 40,
    borderRadius: radius.md,
    backgroundColor: colors.input,
    paddingHorizontal: 14,
    paddingVertical: 8,
    color: colors.foreground,
    fontSize: 15,
    borderWidth: 1,
    borderColor: "transparent",
  },
  focused: { backgroundColor: "rgba(255,255,255,0.07)", borderColor: "rgba(255,255,255,0.14)" },
  disabled: { opacity: 0.5 },
  textarea: { minHeight: 72, borderRadius: radius.md, paddingVertical: 10 },
});
