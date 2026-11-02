import type { Task } from "@cloudagents/protocol"

export const TURN_SOUND_KEY = "kestrel.turnSound"
export const turnSounds = ["off", "chime", "bell", "pop"] as const
export type TurnSound = (typeof turnSounds)[number]

export function getTurnSound(): TurnSound {
  const value = localStorage.getItem(TURN_SOUND_KEY)
  return turnSounds.find((sound) => sound === value) ?? "off"
}

export type SeenTasks = Map<string, Pick<Task, "status" | "updatedAt">>

/**
 * Records a thread's state from a live event or a list snapshot, and tells whether it just became the user's turn.
 * Either can be the older one (a snapshot fetched before an event, or an event still queued behind a snapshot), so a
 * state older than the recorded one is dropped; equal timestamps are taken, as a run's cancel keeps `updatedAt`.
 */
export function observeTask(seen: SeenTasks, task: Task): boolean {
  const previous = seen.get(task.id)
  if (previous !== undefined && task.updatedAt < previous.updatedAt) return false
  seen.set(task.id, { status: task.status, updatedAt: task.updatedAt })
  return previous?.status === "running" && ["done", "failed", "needs_input"].includes(task.status) && !task.archivedAt
}

/** Short synthesized clips avoid a network request when a thread needs attention. */
export function playTurnSound(sound: TurnSound): void {
  if (sound === "off") return
  try {
    const context = new AudioContext()
    const notes = sound === "chime" ? [660, 880] : sound === "bell" ? [880, 1100] : [520]
    notes.forEach((frequency, index) => {
      const start = context.currentTime + index * 0.12
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = sound === "pop" ? "sine" : "triangle"
      oscillator.frequency.setValueAtTime(frequency, start)
      if (sound === "pop") oscillator.frequency.exponentialRampToValueAtTime(260, start + 0.12)
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.15, start + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3)
      oscillator.connect(gain).connect(context.destination)
      oscillator.start(start)
      oscillator.stop(start + 0.3)
    })
    window.setTimeout(() => void context.close(), 1000)
  } catch {
    // Audio may be unavailable or blocked by the browser.
  }
}
