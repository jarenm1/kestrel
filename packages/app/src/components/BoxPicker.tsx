import { useQuery } from "@tanstack/react-query"
import type { BoxList } from "@cloudagents/protocol"
import { ChevronDown, Server } from "lucide-react"
import { queries } from "@/api/queries"
import { Button } from "@cloudagents/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { BAR_TRIGGER_CLASS } from "@/components/RepoPicker"
import { cn } from "@/lib/utils"

/** Radio value of Kestrel's box, whose id is `null`; also how the new-thread page stores that pick. */
export const KESTREL_BOX = "kestrel"

/**
 * Whether `boxId` (`null`: Kestrel's box) answers: a user box's or the managed box's own health, else the relayed
 * status. `undefined` until known, and while the box list has not loaded.
 */
export function useBoxOnline(boxId: string | null, list: BoxList | undefined): boolean | undefined {
  const url = boxId === null ? list?.managedBox?.url : list?.boxes.find((box) => box.id === boxId)?.url
  const health = useQuery({ ...queries.boxHealth(url ?? ""), enabled: url !== undefined })
  const relayed = useQuery({ ...queries.kestrelBox(), enabled: list !== undefined && boxId === null && url === undefined })
  return (url === undefined ? relayed : health).data?.online
}

export function OnlineDot({ boxId, list }: { boxId: string | null; list: BoxList }) {
  const online = useBoxOnline(boxId, list)
  return (
    <span
      aria-label={online === undefined ? "checking" : online ? "online" : "offline"}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        online === undefined ? "bg-muted-foreground/40" : online ? "bg-success" : "bg-destructive",
      )}
    />
  )
}

/** The box a new thread is created on. Picking one here leaves the active box (Settings › Boxes) as it is. */
export function BoxPicker({
  value,
  list,
  onChange,
  disabled,
}: {
  value: string | null
  list: BoxList
  onChange: (boxId: string | null) => void
  disabled?: boolean
}) {
  const name = boxName(value, list)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          title="The box this thread runs on"
          className={BAR_TRIGGER_CLASS}
        >
          <Server className="opacity-70" />
          <span className="truncate">{name}</span>
          <OnlineDot boxId={value} list={list} />
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel>Run this thread on</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value ?? KESTREL_BOX}
          onValueChange={(v) => onChange(v === KESTREL_BOX ? null : v)}
        >
          <DropdownMenuRadioItem value={KESTREL_BOX}>
            <OnlineDot boxId={null} list={list} />
            Kestrel&apos;s box
          </DropdownMenuRadioItem>
          {list.boxes.map((box) => (
            <DropdownMenuRadioItem key={box.id} value={box.id}>
              <OnlineDot boxId={box.id} list={list} />
              <span className="truncate">{box.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Display name of `boxId` (`null`: Kestrel's box) in `list`. */
export const boxName = (boxId: string | null, list: BoxList): string =>
  boxId === null ? "Kestrel's box" : (list.boxes.find((box) => box.id === boxId)?.name ?? "Box")
