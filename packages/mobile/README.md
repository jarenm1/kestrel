# Kestrel mobile

The Expo app. Start Metro with `bun run dev:mobile` (from the repo root) and open it in Expo Go (SDK 58).

- A single React Native `KeyboardAvoidingView` wraps the full-screen app (iOS padding, Android height), above the safe-area padding and page headers, so both composers stay above the keyboard.
- GitHub sign-in captures the `kestrel://auth-callback` redirect inside its WebView; Expo Go does not need to register that custom URL scheme.
- Native API requests authenticate with the session saved in SecureStore and use `credentials: "omit"`: React Native must not merge the WebView cookie jar into the explicit `Cookie` header (which produces a comma-joined, invalid session value).
- In a thread, swipe left over chat or from its right edge to open Desktop/Diff; swipe right over the panel header or left edge to close it. Swipe right over chat for Threads, or use the header buttons. Mostly horizontal swipes tolerate small vertical drift; vertical swipes keep scrolling the content.
- The composer groups modern models by connected Anthropic/OpenAI provider. **Manage models** opens Connections, where each provider's visible models can be toggled or reset. Choices are saved on the device. Thinking opens a stepped slider sheet matching the desktop's monochrome track and effort ring. It offers Default plus only levels supported by the selected model, falls back to Default for unsupported saved levels, and disappears for models without thinking controls. Tap or drag to select; Expo also exposes screen-reader increment/decrement actions, and mobile web uses a native range input with arrow keys, Home and End.

## GitHub references

Type `#` followed by a positive issue/PR number at a word boundary to choose **PR #N** or **Issue #N** above the
composer. Tap a suggestion, or use arrows and Enter/Tab on a hardware keyboard; Escape dismisses the menu.
References use the new thread's repository or an existing thread's sole GitHub checkout. If that context is missing
or ambiguous, choose a repository in the suggestion menu first. Changing the repository never retargets references
already inserted.

Selected references are inline icon labels, not raw URLs. Backspace into a label restores `#number` minus the last
digit and reopens the menu, including with an on-screen keyboard. Ordinary typing and Return stay plain text.
Drafts survive navigation/reload as standard GitHub Markdown links, use the same draft keys as desktop on the web,
and clear only after a successful send. Sent user messages keep other text literal and render only exact reference
tokens as links; agent Markdown uses the same reference presentation.

`packages/composer` owns the reference format and the shared DOM editor, including the WebKit normalization from
#181. Expo's `use dom` renders that editor directly on phone web and in a locally bundled WebView on iOS/Android.
Native typing stays inside the DOM: only the initial draft seeds the view, and Send reads a fresh DOM snapshot
rather than a potentially delayed bridge update. No GitHub credentials enter the editor; the existing
`github_reference_read` tool resolves the explicit repository/kind/number when the agent follows a reference.

## On the web (phones)

The same app is also the app host's UI for phone browsers. `bun run build:app` builds the desktop SPA, then this app's web export (react-native-web, `build:web`) into `packages/app/dist/m`. The Worker serves `m/index.html` in place of the SPA when a phone (`Mobi` in the user agent) opens one of the pages the app has screens for (`/`, `/c/:id`, `/automations`, `/archived`, `/settings/...`; `MOBILE_PAGE` in `packages/control/src/pages.ts`), on the same URL. Other pages (`/pair`, `/login`) and the public site stay on the SPA.

- Platform files (`*.web.ts(x)`, picked by Metro for the web export) hold everything native-only: `auth/session` (the browser's HttpOnly session cookie and same-origin requests instead of SecureStore and an explicit `Cookie` header), `lib/storage` (localStorage), `lib/confirm` (`window.confirm`, since react-native-web's `Alert.alert` does nothing), `components/ui/HtmlView` (a `srcdoc` iframe instead of a WebView, for the desktop stream and the preview frame) and `nav/history`.
- Sign-in is a redirect to GitHub that returns to the page it started on; there is no server URL or token field.
- `nav/history` maps the browser onto the in-memory stack: the address bar follows the screen (the web app's paths), a launch URL opens its screen after sign-in, and the browser's back closes the sidebar or the thread panel, or pops a screen, before leaving the page.
- To try it locally, open the Worker's port (not Vite's) with a phone user agent, e.g. Chrome DevTools device mode: `http://localhost:<worker port>/auth/dev-login`.
