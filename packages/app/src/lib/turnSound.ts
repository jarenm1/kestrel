import type { Task } from "@cloudagents/protocol"

export const TURN_SOUND_KEY = "kestrel.turnSound"
export const turnSounds = ["off", "chime", "bell", "pop"] as const
export type TurnSound = (typeof turnSounds)[number]

export const TURN_VOLUME_KEY = "kestrel.turnSoundVolume"
const DEFAULT_TURN_VOLUME = 50
/** The clips' peak gain at full volume. */
const MAX_GAIN = 0.3

export function getTurnSound(): TurnSound {
  const value = localStorage.getItem(TURN_SOUND_KEY)
  return turnSounds.find((sound) => sound === value) ?? "off"
}

/** The stored volume, a whole percentage. */
export function getTurnVolume(): number {
  const volume = Number(localStorage.getItem(TURN_VOLUME_KEY) || NaN)
  return Number.isInteger(volume) && volume >= 0 && volume <= 100 ? volume : DEFAULT_TURN_VOLUME
}

export type SeenTasks = Map<string, Pick<Task, "status" | "updatedAt">>

/**
 * Records a thread's state from a live event or a list snapshot, and tells whether it just became the user's turn.
 * Either can be the older one (a snapshot fetched before an event, or an event still queued behind a snapshot), so a
 * state older than the recorded one is dropped; equal timestamps are taken, as a run's cancel keeps `updatedAt`.
 * A delegated thread that ends reports to its parent, so only its asking for input is the user's turn.
 */
export function observeTask(seen: SeenTasks, task: Task): boolean {
  const previous = seen.get(task.id)
  if (previous !== undefined && task.updatedAt < previous.updatedAt) return false
  seen.set(task.id, { status: task.status, updatedAt: task.updatedAt })
  if (previous?.status !== "running" || task.archivedAt) return false
  return task.status === "needs_input" || (!task.delegation && (task.status === "done" || task.status === "failed"))
}

/** Short synthesized clips avoid a network request when a thread needs attention. Defaults to the stored choices. */
export function playTurnSound(sound = getTurnSound(), volume = getTurnVolume()): void {
  if (sound === "off" || volume === 0) return
  try {
    const context = new AudioContext()
    // A context created outside a click starts suspended even once the browser allows audio.
    void context.resume().catch(() => {})
    const notes = sound === "chime" ? [660, 880] : sound === "bell" ? [880, 1100] : [520]
    notes.forEach((frequency, index) => {
      const start = context.currentTime + index * 0.12
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = sound === "pop" ? "sine" : "triangle"
      oscillator.frequency.setValueAtTime(frequency, start)
      if (sound === "pop") oscillator.frequency.exponentialRampToValueAtTime(260, start + 0.12)
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime((MAX_GAIN * volume) / 100, start + 0.01)
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
