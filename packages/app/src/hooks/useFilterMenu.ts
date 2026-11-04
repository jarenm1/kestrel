import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react"

/** Hover highlights without moving focus, so the filter box keeps the keyboard while the pointer crosses the list. */
const keepFilterFocus = (e: PointerEvent) => e.preventDefault()

/** Props for each item of a filtered menu: hover highlight that leaves focus in the filter box. */
export const filterItemProps = {
  className: "hover:bg-white/[0.07]",
  onPointerMove: keepFilterFocus,
  onPointerLeave: keepFilterFocus,
}

/**
 * State of a dropdown menu with a filter box over `items`: the open state (closing clears the filter), the items whose
 * `text` contains the filter, and props for the filter input and the list around the items. In the input, typing stays
 * in the box (the menu's typeahead would move focus to an item), ArrowDown moves to the first item, and Enter picks the
 * first match. Picking closes the menu unless `keepOpen` (menus that toggle several items in one go).
 */
export function useFilterMenu<T>(
  items: readonly T[],
  text: (item: T) => string,
  onPick: (item: T) => void,
  { keepOpen = false }: { keepOpen?: boolean } = {},
) {
  const [open, setOpenState] = useState(false)
  const [filter, setFilter] = useState("")
  const listRef = useRef<HTMLDivElement>(null)
  const needle = filter.trim().toLowerCase()
  const matches = items.filter((item) => text(item).toLowerCase().includes(needle))

  function setOpen(next: boolean) {
    setOpenState(next)
    if (!next) setFilter("")
  }

  function pick(item: T) {
    onPick(item)
    if (!keepOpen) setOpen(false)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") return
    e.stopPropagation()
    if (e.key === "ArrowDown") {
      e.preventDefault()
      listRef.current?.querySelector<HTMLElement>("[role=menuitemradio],[role=menuitemcheckbox]")?.focus()
    } else if (e.key === "Enter" && needle !== "") {
      e.preventDefault()
      const first = matches[0]
      if (first !== undefined) pick(first)
    }
  }

  return {
    open,
    setOpen,
    /** The filter as typed, trimmed; empty when there is none. */
    query: filter.trim(),
    matches,
    pick,
    listRef,
    inputProps: { autoFocus: true, value: filter, onChange: (e: { target: { value: string } }) => setFilter(e.target.value), onKeyDown },
  }
}
