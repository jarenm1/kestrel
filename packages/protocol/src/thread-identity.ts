import type { Task } from "./index"

/** One of eight glass finishes, picked by a hash of what the identity is keyed on. */
export type ThreadTone = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7

/** Two-hue glass tint per finish, [top-left, bottom-right], shared by web and mobile. Green, amber and red stay reserved for status. */
export const THREAD_TINTS: Record<ThreadTone, readonly [string, string]> = {
  0: ["#2b7a86", "#2e3a7a"], // lagoon: teal → indigo
  1: ["#6a4aa0", "#7a3a68"], // dusk: violet → plum
  2: ["#a3507e", "#4a2d6a"], // rosewood: rose → violet
  3: ["#8e4a9c", "#3b3f8f"], // orchid: magenta → indigo
  4: ["#2f8c9c", "#5b3f99"], // aurora: cyan → violet
  5: ["#3a62c4", "#1f2c66"], // cobalt: blue → navy
  6: ["#6b3a6e", "#262f5e"], // mulberry: plum → deep blue
  7: ["#5a5c63", "#232428"], // graphite
}

export interface ThreadIdentity {
  /** Up to two letters or digits, uppercased; `KT` when the name has none. */
  readonly monogram: string
  readonly tone: ThreadTone
  /** The first checkout's repository icon, shown instead of the monogram while it loads and renders. */
  readonly icon: { readonly checkoutId: string; readonly blob: string } | null
}

/** Two initials of a name: of its first two words, or the first two letters of a single word. */
function monogramOf(name: string): string {
  const words = name.normalize("NFKC").match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? []
  const firstWord = words[0]?.match(/[\p{L}\p{N}]\p{M}*/gu) ?? []
  const second = words[1]?.match(/^[\p{L}\p{N}]\p{M}*/u)?.[0] ?? firstWord[1] ?? ""
  // Match code points with their combining marks; uppercase can expand one letter (e.g. ß → SS).
  return `${firstWord[0] ?? ""}${second}`.toUpperCase().match(/[\p{L}\p{N}]\p{M}*/gu)?.slice(0, 2).join("") || "KT"
}

function toneOf(key: string): ThreadTone {
  let hash = 0
  for (const character of key) hash = (Math.imul(hash, 31) + character.codePointAt(0)!) >>> 0
  return (hash % 8) as ThreadTone
}

/**
 * Local presentation only. A thread with a checkout takes its first repository's identity (its icon, else initials
 * of the repository name), so every thread on that repo looks the same. Before any checkout, initials come from the
 * title and the finish from the thread ID, so a rename changes the letters but not the finish.
 */
export function threadIdentity(task: Pick<Task, "id" | "title" | "checkouts">): ThreadIdentity {
  const checkout = task.checkouts[0]
  if (checkout === undefined) return { monogram: monogramOf(task.title), tone: toneOf(task.id), icon: null }
  // `owner/name` or an https clone URL: the name is the last path segment, without `.git`.
  const name = checkout.repo.replace(/\/+$/, "").split("/").pop()!.replace(/\.git$/i, "")
  return {
    monogram: monogramOf(name),
    tone: toneOf(checkout.repo.toLowerCase()),
    icon: checkout.icon === undefined ? null : { checkoutId: checkout.id, blob: checkout.icon.blob },
  }
}
