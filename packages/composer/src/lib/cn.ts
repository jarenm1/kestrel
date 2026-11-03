import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// Custom shadow tokens from the app's styles.css, so e.g. `shadow-none` passed via className overrides `shadow-well`.
const twMerge = extendTailwindMerge({ extend: { theme: { shadow: ["soft", "glow", "well"] } } })

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
