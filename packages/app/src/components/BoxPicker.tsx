import { useQuery } from "@tanstack/react-query"
import type { BoxList } from "@cloudagents/protocol"
import { ChevronDown, Server } from "lucide-react"
import type { BoxHealth } from "@/api/client"
import { queries } from "@/api/queries"
import { HEALTH_LABEL } from "@/components/Boxes"
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
 * How `boxId` (`null`: Kestrel's box) is doing: a user box's or the managed box's own health, else the relayed status.
 * `undefined` until known, and while the box list has not loaded.
 */
export function useBoxHealth(boxId: string | null, list: BoxList | undefined): BoxHealth | undefined {
  const own = boxId === null ? undefined : list?.boxes.find((box) => box.id === boxId)
  const url = boxId === null ? list?.managedBox?.url : own?.url
  // A Nest box is Kestrel-run and updates itself, like the managed box: only a box the user runs is checked further.
  const ownBoxId = own === undefined || own.nest ? undefined : own.id
  const health = useQuery({ ...queries.boxHealth(url ?? "", ownBoxId), enabled: url !== undefined })
  const relayed = useQuery({ ...queries.kestrelBox(), enabled: list !== undefined && boxId === null && url === undefined })
  if (url !== undefined) return health.data
  if (relayed.data === undefined) return undefined
  return { state: relayed.data.online ? "online" : "offline", version: relayed.data.boxVersion }
}

export function OnlineDot({ boxId, list }: { boxId: string | null; list: BoxList }) {
  const health = useBoxHealth(boxId, list)
  return (
    <span
      aria-label={health === undefined ? "checking" : HEALTH_LABEL[health.state]}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        health === undefined
          ? "bg-muted-foreground/40"
          : health.state === "online"
            ? "bg-success"
            : health.state === "offline"
              ? "bg-destructive"
              : "bg-warning",
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
