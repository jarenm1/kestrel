import type { Effect } from "effect"
import type { InternalError } from "@cloudagents/protocol"
import { nixInstall } from "./nix"

/**
 * Heavy desktop apps a task opts into. Each is the flake's `toolkit-<name>` package (flake.nix): built on the
 * host with `nix build` the first time any task installs it, then shared through the read-only /nix/store.
 */
export const TOOLKITS = {
  blender: "Blender (3D modelling, rendering, Python scripting). `blender` opens the GUI; `blender -b file.blend -P script.py` runs headless.",
  "roblox-studio":
    "Roblox Studio through Vinegar (Wine), plus Rojo and Wally. `vinegar run` downloads Studio on first use and opens it. Studio needs the user signed in to Roblox: its \"Login via Browser\" opens Firefox on the desktop, where the user signs in to roblox.com (Quick Login with a code approved from a device already signed in avoids typing a password here), then lets Firefox open the returned link with Vinegar. Ask the user (task_ask) to do this on the desktop; never handle their credentials yourself. Rojo syncs workspace files into Studio once its Studio plugin is installed.",
} as const

export type ToolkitName = keyof typeof TOOLKITS

export const TOOLKIT_NAMES = Object.keys(TOOLKITS) as [ToolkitName, ...ToolkitName[]]

/**
 * Builds the toolkit from the box's flake (`CLOUDAGENTS_TOOLKITS_FLAKE`) and puts its executables on the task's PATH
 * (see `nixInstall`). Installing again rebuilds from the box's current flake. Returns the executable names.
 */
export const installToolkit = (
  flake: string,
  homeDir: string,
  name: ToolkitName,
): Effect.Effect<ReadonlyArray<string>, InternalError> => nixInstall(homeDir, "toolkits", name, [`${flake}#toolkit-${name}`])
