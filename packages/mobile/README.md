# Kestrel mobile

The Expo app. Start Metro with `bun run dev:mobile` (from the repo root) and open it in Expo Go (SDK 58).

- A single React Native `KeyboardAvoidingView` wraps the full-screen app (iOS padding, Android height), above the safe-area padding and page headers, so both composers stay above the keyboard.
- GitHub sign-in captures the `kestrel://auth-callback` redirect inside its WebView; Expo Go does not need to register that custom URL scheme.
- Native API requests authenticate with the session saved in SecureStore and use `credentials: "omit"`: React Native must not merge the WebView cookie jar into the explicit `Cookie` header (which produces a comma-joined, invalid session value).
- In a thread, swipe left over chat or from its right edge to open Desktop/Diff; swipe right over the panel header or left edge to close it. Swipe right over chat for Threads, or use the header buttons. Mostly horizontal swipes tolerate small vertical drift; vertical swipes keep scrolling the content.
- The composer groups modern models by connected Anthropic/OpenAI provider. **Manage models** opens Connections, where each provider's visible models can be toggled or reset. Choices are saved on the device. Thinking offers only levels supported by the selected model, and disappears for models without thinking controls.
