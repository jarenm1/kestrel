# Kestrel mobile

The Expo app. Start Metro with `bun run dev:mobile` (from the repo root) and open it in Expo Go (SDK 58).

- A single React Native `KeyboardAvoidingView` wraps the full-screen app (iOS padding, Android height), above the safe-area padding and page headers, so both composers stay above the keyboard.
- GitHub sign-in captures the `kestrel://auth-callback` redirect inside its WebView; Expo Go does not need to register that custom URL scheme.
- Native API requests authenticate with the session saved in SecureStore and use `credentials: "omit"`: React Native must not merge the WebView cookie jar into the explicit `Cookie` header (which produces a comma-joined, invalid session value).
- In a thread, swipe left over chat or from its right edge to open Desktop/Diff; swipe right over the panel header or left edge to close it. Swipe right over chat for Threads, or use the header buttons. Mostly horizontal swipes tolerate small vertical drift; vertical swipes keep scrolling the content.
- The composer's model sheet matches the desktop picker: a rail of the connected harnesses (Claude Code, Codex, OpenCode, Antigravity), each harness's models grouped by the provider behind them, and a search box over every harness that labels matches with their harness and provider. Opening restores the selected model's harness; the selected model carries a check. The sheet keeps its tallest harness's height (bounded, then scrolling), so switching harnesses or searching never resizes it. **Manage models** opens Connections: **Harnesses/Subscriptions** shows each installed harness with its model-visibility picker beside the name, and **API keys** keeps provider keys and key-based CLI logins together with their preferences. Each picker searches, toggles and resets the models offered in chat, and choices are saved on the device (per thread for an open thread). Thinking opens a stepped slider sheet matching the desktop's monochrome track and effort ring. It offers Default plus only levels supported by the selected model, falls back to Default for unsupported saved levels, and disappears for models without thinking controls. Tap or drag to select; Expo also exposes screen-reader increment/decrement actions, and mobile web uses a native range input with arrow keys, Home and End. The model sheet is a bottom sheet with a close button and screen-reader radio rows; on phone web, Left/Right arrows step the harness rail while the search box is empty.
- The composer's editable area stays transparent and shadow-free, including while focused, so it sits flush inside the outer box. The outer box retains its depth and focus border.
- **Settings › Threads** (`/settings/threads`) mirrors the web app's Threads page: the text-generation switch (its choices stay saved and visible while off), the model and its supported thinking level, title instructions (saved on blur, with Reset), response streaming and usage-limit auto-resume. Reads and writes go through the active box's client and are cached per box. A screen opened on one box keeps writing there, and rapid changes are serialized so the latest snapshot saves next instead of racing an earlier PUT.

## Thread sidebar

The drawer lists every box's threads newest first. Running threads leave the list and appear once in a **working dock** above the account row; idle, done, failed and needs-input threads stay in the list, and archived threads are only counted on the Archived row. Rows keep their box in their key, navigation and archive call, so two boxes with the same thread id never merge.

- The dock header shows the running count and folds the body; the folded state is remembered in `kestrel.workingDockCollapsed` (SecureStore natively, localStorage on phone web, the same key the web app uses), and the dock disappears when the last run ends or is archived. A saved fold is applied before the dock's first visible frame, so opening the drawer never replays a closing animation over its rows; only a user's tap animates the fold. Its body is capped at 45% of the sidebar and scrolls, so many concurrent runs stay reachable above the account row.
- Folded dock contents are hidden from screen readers (`aria-hidden`, `importantForAccessibility="no-hide-descendants"`), ignore touches, and their rows and archive buttons leave the keyboard tab order (`focusable={false}`, plus `tabIndex={-1}` on the web); the header keeps `aria-expanded` and describes the fold action.
- Reordering and list↔dock transfers animate with React Native Reanimated (`LinearTransition`, `FadeIn`/`FadeOut`, directional `Keyframe` entries, and a timed height fold). The presets and the fold timing honor the OS reduce-motion setting. Opening the drawer does not replay entry animations.
- Thread rows are rendered without `FlatList` virtualization so rows stay mounted for layout and exit animations; this matches the desktop sidebar, which also renders its full thread list. The list and dock remain ordinary vertical `ScrollView`s, so the drawer's horizontal swipe and per-list scrolling are unchanged.

## Commands

Type `/` to browse commands, or `$` in a Codex thread to browse its skills. Tap a harness suggestion to fill the
draft, add any arguments, then tap **Send**. The menu stays available when touching it takes focus from the editor,
on both phone web and native. Hardware keyboards can use arrows and Enter/Tab to select, or Escape to dismiss;
outside the menu, Return inserts a newline.

App commands behave differently: tapping **/usage** immediately opens Quotas, without sending a message to the
agent. Sending a typed `/usage` does the same. It works in a new thread without a model or while harness commands
are loading. Only the command and its following whitespace leave the draft; Back returns to any remaining text
and references.

App-command suggestions synchronously lock the DOM editor before taking a live snapshot. Send first reads the
live editor without changing focus or the keyboard; typed app commands then request their own locked snapshot.
Ordinary messages never lock the editor. App commands keep editing disabled through saving and the navigation
handoff until the original editor unmounts; rejected actions or failed saves unlock the original draft.
Navigation waits for storage. Reads and writes for each draft share an ordering queue across composer mounts,
so returning immediately cannot restore the consumed command or race newer edits.

The app-command catalog and invocation rules live in `@cloudagents/composer/commands`, shared with desktop.
Add future local actions there and implement their `AppCommandHandlers` entry on both hosts; selection and
submission use the same resolver, and app actions override same-named slash commands without hiding `$skills`.

## Model mentions

Type `@` at a word boundary to search the same connected models the chat picker offers. Each suggestion shows the
harness's mark, the model's name and its smaller, provider-qualified slug; tap one, or use arrows and Enter/Tab on a
hardware keyboard, and Escape dismisses the menu. The leading `/` or `$` command menu wins over it, and the GitHub
reference menu comes last.

Picking a mention inserts an atomic chip, never changes the composer's answering model, and leaves the next Send's
model exactly as the picker had it. The chip serializes to the exact catalog model id, provider and harness, so the
agent can delegate to it. Drafts restored from another box still draw the chip's harness logo: the native menu and
the DOM editor both use the catalog-wide logo map derived from the shared provider-to-harness mapping.

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

## Settings

Settings mirrors the web app's sections as a phone hub: Profile, Connections, Boxes and Billing rows, each opening its
own page with a back control. Sections keep the web URLs: `/settings` is the hub, `/settings/profile`,
`/settings/boxes` and `/settings/billing` open a section directly, `/settings/connections` is the existing Connections
screen, and `/settings/usage` is Quotas.

- **Profile** shows the GitHub account (avatar, name, `@login`, link to the GitHub profile, sign-in badge), GitHub
  access with Connect/Reconnect, and Sign out. GitHub access lives here rather than in Connections, as on desktop; the
  OAuth callback returns to `/settings/profile` (`ControlPaths.connectOAuth("github")?return=/settings/profile`) and
  the repository picker's "connect GitHub" action opens this section. On the web build the browser holds the session,
  so Connect leaves and returns to the page. A native app has no session in its external browser, so it explains that
  connecting happens in the web app and opens the web profile to connect there.
- **Connections** keeps its own route and lists model access only (harnesses/subscriptions and API keys); the hub
  links to it. There is no GitHub row here.
- **Boxes** keeps the active-box switch (Kestrel's box or a BYOB box); boxes are still created and deleted on the web.
- **Billing** keeps the plan, agent-hours usage and the Quotas link, and adds the web app's plan price, progress,
  period dates, plan list and payment/invoice rows.
- The desktop's browser-only turn-sound preference is not ported: the mobile app has no turn-sound playback or
  notification to control, so the card would be a setting with no effect.

## Shared desktop components

Some screens render the desktop's own components from `packages/ui` instead of a React Native copy, so a change to
them lands on desktop, phone web and native at once: the **chat transcript** (messages, run items, tool calls,
Markdown) and **Settings › Quotas** (`/settings/usage`, the desktop's quotas panel).

- `screens/UsageScreen` owns the data (TanStack Query, the box client) and passes plain JSON props and async
  callbacks to `components/UsageQuotasDom`, a `"use dom"` wrapper around `@cloudagents/ui/usage`.
- On phone web the wrapper renders in place; on iOS/Android Expo bundles it into a WebView sized with
  `matchContents`, and the native `ScrollView` scrolls the page.
- Styles: the wrapper imports `@cloudagents/ui/dom.css`, which Metro compiles with Tailwind v4
  (`postcss.config.mjs`). It has no preflight, so it cannot restyle react-native-web; element resets apply only inside
  `[data-kestrel-dom]`. Utilities are generated from `packages/ui` sources only, so put Tailwind classes there, not in
  the wrapper. `components/domHostReset` shrink-wraps the WebView document (native only).
- To add another: move the component into `packages/ui` with JSON-only props, render it from the desktop as before,
  and add a `*Dom.tsx` wrapper plus a screen that supplies the data.

### The chat transcript

`components/ChatPanel` keeps the native composer and working indicator, and renders the thread through
`components/TranscriptDom` (`@cloudagents/ui/transcript`), which scrolls itself and follows new output while the
reader is at the bottom, like the desktop.

- **Data.** `useTaskState` keeps the query cache live as before. `hooks/useTranscriptBridge` sends the DOM side the
  whole thread once per epoch (a prop), then each change as a patch through its ref: only the changed tail of the
  messages, runs or a run's items (`lib/transcriptBridge`). A streamed token costs one item, not the thread. The DOM
  side asks for a new epoch when it mounts or a patch goes missing (a `seq` gap).
- **Files.** A WebView `<img>` cannot send the session `Cookie` header, so images use `ApiClient.fileAccess()`: the
  box token on a direct box, or a one-hour file token (`ControlPaths.fileToken`) that the Worker accepts in place of
  the cookie only for GETs of box files on the relayed box. The token belongs to the session that minted it and ends
  with it (sign-out). It is renewed before it expires, and when an image fails to load.
- **Links.** In the native WebView, links and files open in the system browser (`Linking`); on phone web they are
  ordinary anchors. A link to another thread opens it in the app.
- `components/domHostReset`'s `domFillReset` makes the WebView document exactly the view's size (native only).

## On the web (phones)

The same app is also the app host's UI for phone browsers. `bun run build:app` builds the desktop SPA, then this app's web export (react-native-web, `build:web`) into `packages/app/dist/m`. The Worker serves `m/index.html` in place of the SPA when a phone (`Mobi` in the user agent) opens one of the pages the app has screens for (`/`, `/c/:id`, `/automations`, `/archived`, `/settings/...`; `MOBILE_PAGE` in `packages/control/src/pages.ts`), on the same URL. Other pages (`/pair`, `/login`) and the public site stay on the SPA.

- Platform files (`*.web.ts(x)`, picked by Metro for the web export) hold everything native-only: `auth/session` (the browser's HttpOnly session cookie and same-origin requests instead of SecureStore and an explicit `Cookie` header), `lib/storage` (localStorage), `lib/confirm` (`window.confirm`, since react-native-web's `Alert.alert` does nothing), `components/ui/HtmlView` (an iframe instead of a WebView: `src` for the desktop embed, `srcdoc` for the preview frame; messages are accepted from the iframe's window only) and `nav/history`.
- The desktop viewer (`components/DesktopViewer.tsx`) loads `<app host>/embed/desktop#ws=<encoded stream URL>&task=<id>` in an `HtmlView`: a WebView natively, an iframe on the web. The app host is the server URL, also for a user's direct box; the ws URL carries the auth (`ApiClient.desktopSocketUrl`: a box token, or on the relayed box a five-minute desktop token for that task), so the WebView never holds the session. The embed posts `{type: "kestrel-desktop", event: "status" | "auth-expired" | "unreachable"}` to the host. On `auth-expired` (the socket said it is not authorized) the viewer mints a fresh token and posts `{type: "kestrel-desktop", ws}` back to the embed, so the page keeps its WebRTC session; a second `auth-expired` within 5 seconds is shown as an error instead of retried. `unreachable` means a handshake failed, which a browser cannot explain: the embed says so and keeps retrying, and the viewer mints a fresh URL at most every 30 seconds in case the token expired. The embed connects only to desktop stream URLs, refuses a frame from another site, and leaves its own host only inside the native WebView or the app's own frame. The embed is unmounted while the app is in the background.
- Sign-in is a redirect to GitHub that returns to the page it started on; there is no server URL or token field.
- `nav/history` maps the browser onto the in-memory stack: the address bar follows the screen (the web app's paths), a launch URL opens its screen after sign-in, and the browser's back closes the sidebar or the thread panel, or pops a screen, before leaving the page.
- To try it locally, open the Worker's port (not Vite's) with a phone user agent, e.g. Chrome DevTools device mode: `http://localhost:<worker port>/auth/dev-login`.
