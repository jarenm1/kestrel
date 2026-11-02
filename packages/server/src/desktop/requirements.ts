/** The desktop's executables. The box probe (capabilities.ts), `kestrel-box doctor` and the helper build all read this. */

/** The capture helper built by `kestrel-box desktop` (cli/desktop.ts); it runs ffmpeg as its child. */
export const DESKTOP_HELPER = "xdamage-capture"

/**
 * On PATH for a desktop to start: weston (critical; hosts Xwayland), the input helper and ffmpeg (under the
 * capture helper). A missing one fails the start.
 */
export const DESKTOP_REQUIRED_TOOLS = ["weston", "Xwayland", "xdotool", "ffmpeg"] as const

/** Started when found; a desktop without them still runs (no wallpaper, no window manager, no terminal). */
export const DESKTOP_OPTIONAL_TOOLS = ["openbox", "hsetroot", "xterm"] as const

/** The desktop starts Xwayland as weston's client (`weston … -- Xwayland …`), which weston supports from 14.0. */
export const MIN_WESTON_MAJOR = 14

/** The version in `weston --version` output (`weston 14.0.1`) and its major number, or null when there is none. */
export const parseWestonVersion = (output: string): { readonly text: string; readonly major: number } | null => {
  const match = /weston (\d+)\.\S*/.exec(output)
  return match === null ? null : { text: match[0], major: Number(match[1]) }
}
