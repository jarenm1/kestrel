import { useState, type CSSProperties } from "react"
import { useQuery } from "@tanstack/react-query"
import { Paths, THREAD_TINTS, threadIdentity, type Task } from "@cloudagents/protocol"
import { queries } from "@/api/queries"

/** Glass: a hard sheen across the top half over the tint, inside a border lit from above. */
function glass([from, to]: readonly [string, string]): CSSProperties {
  return {
    background: [
      "linear-gradient(180deg, rgb(255 255 255 / 0.18), rgb(255 255 255 / 0.07) 50%, transparent 50%) padding-box",
      `linear-gradient(135deg, ${from}, ${to}) padding-box`,
      "linear-gradient(180deg, rgb(255 255 255 / 0.32), rgb(255 255 255 / 0.06) 50%, rgb(255 255 255 / 0.02)) border-box",
    ].join(", "),
  }
}

/**
 * Local thread identity, independent of run state: the first checkout's repository icon once it has loaded, else
 * the monogram (of the repository name, or of the title before any checkout).
 */
export function ThreadAvatar({ task }: { task: Pick<Task, "id" | "title" | "checkouts"> }) {
  const { monogram, tone, icon } = threadIdentity(task)
  const { data: src } = useQuery({
    ...queries.taskFileUrl(task.id, icon === null ? "" : Paths.taskCheckoutIcon(task.id, icon.checkoutId, icon.blob)),
    enabled: icon !== null,
  })
  // The URL that has loaded; a failed load (gone from the mirror, not decodable) keeps the monogram.
  const [loaded, setLoaded] = useState<string | null>(null)
  const showIcon = src !== undefined && loaded === src
  return (
    <span
      aria-hidden="true"
      // Icons bring their own colours: they sit on the neutral graphite glass.
      style={glass(THREAD_TINTS[showIcon ? 7 : tone])}
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-[0.5rem] border border-transparent font-sans text-[11px] leading-none font-semibold tracking-[0.01em] text-white/95 shadow-soft [text-shadow:0_1px_1px_rgb(0_0_0/0.35)]"
    >
      {/* Trim to cap height so the letters, not the line box, sit on the tile's center. */}
      {!showIcon && <span className="[text-box:trim-both_cap_alphabetic]">{monogram}</span>}
      {src !== undefined && (
        <img
          src={src}
          alt=""
          className={showIcon ? "size-4.5 object-contain" : "hidden"}
          onLoad={() => setLoaded(src)}
          onError={() => setLoaded(null)}
        />
      )}
    </span>
  )
}
