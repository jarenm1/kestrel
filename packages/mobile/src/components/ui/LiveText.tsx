import React, { type ReactNode, useEffect, useRef } from "react";
import { Animated, Easing, type StyleProp, type TextStyle } from "react-native";
import { useReducedMotion } from "react-native-reanimated";

/**
 * The web's shimmer, as a slow fade: one line of text for what the agent is working on right now (a thread's title,
 * a tool call). Still when not `live`, or when the OS asks for reduced motion.
 */
export function LiveText({ live, style, children }: { live: boolean; style: StyleProp<TextStyle>; children: ReactNode }) {
  const reduceMotion = useReducedMotion();
  const fade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!live || reduceMotion) {
      fade.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(fade, { toValue: 0.4, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(fade, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [live, reduceMotion, fade]);
  return (
    <Animated.Text style={[style, { opacity: fade }]} numberOfLines={1}>
      {children}
    </Animated.Text>
  );
}
