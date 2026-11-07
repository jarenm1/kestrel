/** Local time, consistently using a 12-hour clock without seconds. */
export function formatMessageTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })
}
