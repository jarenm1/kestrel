import { Zap } from "lucide-react"
import { DropdownMenuItem, DropdownMenuLabel } from "../dropdown-menu"

/** One pull request of the list, by repository ("owner/name") and number. */
export interface PullRequestRef {
  readonly repo: string
  readonly number: number
}

/** A user-defined automation that runs only when picked for pull requests. */
export interface PullRequestQuickAction {
  readonly id: string
  readonly name: string
  /** Offered only for this repository's pull requests; null for any repository. */
  readonly repo: string | null
}

/** How one batch went: the runs that started, and why the others did not. */
export interface PullRequestQuickActionResult {
  readonly started: number
  readonly failures: readonly { readonly target: PullRequestRef; readonly error: string }[]
}

export interface PullRequestQuickActions {
  /** The user's quick actions; null until they are read. */
  actions: readonly PullRequestQuickAction[] | null
  /** Display text of the read error. */
  error: string | null
  /** Starts one run per target. A rejection counts as every target failing with its message. */
  onRun: (action: PullRequestQuickAction, targets: readonly PullRequestRef[]) => Promise<PullRequestQuickActionResult>
  /** Opens the settings where quick actions are defined. */
  onManage: () => void
}

/** Whether `action` may run on a pull request of `repo`; GitHub compares repository names case-insensitively. */
export const quickActionApplies = (action: PullRequestQuickAction, repo: string): boolean =>
  action.repo === null || action.repo.toLowerCase() === repo.toLowerCase()

/** The menu entries for running a quick action on `targets`: only actions that apply to every one of them. */
export function QuickActionItems({
  quickActions,
  targets,
  disabled,
  onPick,
}: {
  quickActions: PullRequestQuickActions
  targets: readonly PullRequestRef[]
  disabled: boolean
  onPick: (action: PullRequestQuickAction) => void
}) {
  const actions = quickActions.actions
  const applicable = actions?.filter((action) => targets.every((target) => quickActionApplies(action, target.repo))) ?? []
  let empty: string | null = null
  if (actions === null) empty = quickActions.error ?? "Loading…"
  else if (actions.length === 0) empty = "No quick actions yet."
  else if (applicable.length === 0) {
    empty = targets.length > 1 ? "None apply to every selected repository." : "None apply to this repository."
  }

  return (
    <>
      <DropdownMenuLabel>Quick actions</DropdownMenuLabel>
      {empty !== null && <DropdownMenuLabel className="pt-0 text-foreground/70">{empty}</DropdownMenuLabel>}
      {applicable.map((action) => (
        <DropdownMenuItem key={action.id} disabled={disabled} onSelect={() => onPick(action)}>
          <Zap />
          <span className="truncate">{action.name}</span>
        </DropdownMenuItem>
      ))}
    </>
  )
}

/** One line on how a batch went, e.g. "Started “Review” on 3 pull requests." plus one line per failure. */
export function describeQuickActionResult(
  name: string,
  targets: readonly PullRequestRef[],
  result: PullRequestQuickActionResult,
): string {
  const label = (target: PullRequestRef) => (targets.every((t) => t.repo === target.repo) ? "" : target.repo) + `#${target.number}`
  const what = targets.length === 1 && targets[0] !== undefined ? label(targets[0]) : `${targets.length} pull requests`
  const lines =
    result.failures.length === 0
      ? [`Started “${name}” on ${what}.`]
      : result.started === 0
        ? [`“${name}” did not start on ${what}.`]
        : [`Started “${name}” on ${result.started} of ${targets.length} pull requests.`]
  for (const failure of result.failures) lines.push(`${label(failure.target)}: ${failure.error}`)
  return lines.join("\n")
}
