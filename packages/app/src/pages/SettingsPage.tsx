import { useQuery } from "@tanstack/react-query"
import { CURRENT_PLAN, PLANS, type Plan, type Usage } from "@cloudagents/protocol"
import { Check, CreditCard, ExternalLink, LogOut, Plug, User } from "lucide-react"
import { Link, NavLink, Outlet } from "react-router-dom"
import { queries } from "@/api/queries"
import { Connections } from "@/components/Connections"
import { Alert } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { useSignOut } from "@/hooks/useSignOut"
import { cn } from "@/lib/utils"
import { errorText } from "@/util"

const sections = [
  { to: "profile", label: "Profile", icon: User },
  { to: "connections", label: "Connections", icon: Plug },
  { to: "billing", label: "Billing", icon: CreditCard },
] as const

export function SettingsLayout() {
  return (
    // Sized by the panel it sits in (beside the threads strip), not the viewport.
    <div className="@container min-h-0 flex-1 overflow-auto">
      {/* The nav column is mirrored by an empty one on the right, so the content sits in the middle of the page. */}
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6 @5xl:grid @5xl:max-w-none @5xl:grid-cols-[11rem_minmax(0,48rem)_11rem] @5xl:justify-center @5xl:gap-10">
        <aside className="flex shrink-0 flex-col gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
          <nav className="flex gap-1 @5xl:flex-col">
            {sections.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors duration-200 hover:text-foreground",
                    isActive && "bg-white/[0.07] text-foreground",
                  )
                }
              >
                <Icon className="size-4" />
                {label}
              </NavLink>
            ))}
          </nav>
        </aside>
        <section className="flex min-w-0 flex-1 flex-col gap-6">
          <Outlet />
        </section>
      </div>
    </div>
  )
}

function SectionHeader({ title, desc }: { title: string; desc: string }) {
  return (
    <div>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="text-muted-foreground">{desc}</p>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-4">
      <span className="w-32 shrink-0 text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
    </div>
  )
}

export function ProfileSettings() {
  const me = useQuery(queries.me())
  const signOut = useSignOut()
  if (!me.data) return null
  const { login, name, avatarUrl } = me.data

  return (
    <>
      <SectionHeader title="Profile" desc="Your Kestrel account comes from GitHub." />
      <Card className="py-0">
        <CardContent className="flex items-center gap-4 px-5 py-5">
          <div className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-full bg-white/[0.08] text-lg font-medium uppercase shadow-soft">
            {avatarUrl ? <img className="size-full" src={avatarUrl} alt="" /> : login.slice(0, 1)}
          </div>
          <div className="min-w-0">
            <div className="truncate text-base font-semibold">{name ?? login}</div>
            <div className="truncate font-mono text-xs text-muted-foreground">@{login}</div>
          </div>
          <Button asChild variant="soft" size="sm" className="ml-auto">
            <a href={`https://github.com/${login}`} target="_blank" rel="noopener noreferrer">
              GitHub profile <ExternalLink />
            </a>
          </Button>
        </CardContent>
      </Card>
      <Card className="py-0">
        <CardContent className="divide-y divide-white/[0.04] px-0">
          <Row label="Name">{name ?? <span className="text-muted-foreground">Not set on GitHub</span>}</Row>
          <Row label="Username">
            <span className="font-mono">{login}</span>
          </Row>
          <Row label="Sign-in">
            <Badge variant="success">GitHub</Badge>
          </Row>
          <Row label="Connections">
            <span className="text-muted-foreground">Model keys, subscriptions and GitHub access.</span>
            <Button asChild variant="soft" size="sm" className="ml-auto">
              <Link to="/settings/connections">Manage</Link>
            </Button>
          </Row>
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        Name and avatar update from GitHub each time you sign in.
      </p>
      <div>
        <Button variant="soft" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
          <LogOut />
          Sign out
        </Button>
      </div>
    </>
  )
}

export function ConnectionsSettings() {
  return (
    <>
      <SectionHeader title="Connections" desc="Accounts and keys Kestrel uses on your behalf." />
      <Connections />
    </>
  )
}

const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" })

function hours(seconds: number): string {
  const h = seconds / 3600
  if (h > 0 && h < 0.1) return "<0.1"
  return h < 10 ? h.toFixed(1) : Math.round(h).toString()
}

export function BillingSettings() {
  const usage = useQuery(queries.usage())
  const current = PLANS.find((p) => p.id === CURRENT_PLAN)!

  return (
    <>
      <SectionHeader title="Billing" desc="Your plan and this month's agent usage." />
      <Card className="gap-0 py-0 shadow-glow">
        <CardContent className="flex flex-wrap items-start gap-4 px-5 py-5">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="text-xs tracking-wider text-muted-foreground uppercase">Current plan</span>
              <Badge variant="success">active</Badge>
            </div>
            <div className="text-2xl font-semibold tracking-tight">{current.name}</div>
            <p className="text-muted-foreground">{current.desc}</p>
          </div>
          <div className="ml-auto flex items-baseline gap-2">
            <span className="text-3xl font-semibold tracking-tight">{current.price}</span>
            <span className="text-sm text-muted-foreground">{current.period}</span>
          </div>
        </CardContent>
        <div className="border-t border-white/[0.04] px-5 py-5">
          {usage.error && <Alert>{errorText(usage.error)}</Alert>}
          {usage.isPending && <div className="text-muted-foreground">Loading usage…</div>}
          {usage.data && <UsageSummary usage={usage.data} plan={current} />}
        </div>
      </Card>

      <div className="flex flex-col gap-3">
        <SectionHeader title="Plans" desc="Paid plans open when billing goes live; everyone is on Hobby for now." />
        <div className="grid gap-4 md:grid-cols-3">
          {PLANS.map((plan) => (
            <PlanCard key={plan.id} plan={plan} current={plan.id === CURRENT_PLAN} />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <SectionHeader title="Payment and invoices" desc="Cards and receipts for paid plans." />
        <Card className="py-0">
          <CardContent className="divide-y divide-white/[0.04] px-0">
            <Row label="Payment method">
              <span className="text-muted-foreground">None. The Hobby plan needs no card.</span>
            </Row>
            <Row label="Invoices">
              <span className="text-muted-foreground">No invoices yet.</span>
            </Row>
          </CardContent>
        </Card>
      </div>
    </>
  )
}

function UsageSummary({ usage, plan }: { usage: Usage; plan: Plan }) {
  const usedHours = usage.agentSeconds / 3600
  const share = plan.agentHours === null ? 0 : Math.min(1, usedHours / plan.agentHours)
  const lastDay = new Date(Date.parse(usage.periodEnd) - 1)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium">Agent hours</span>
          <span className="text-muted-foreground">
            <span className="font-semibold text-foreground">{hours(usage.agentSeconds)}</span>
            {plan.agentHours === null ? " used" : ` of ${plan.agentHours} h`}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="Agent hours used"
          aria-valuenow={Math.round(share * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-2 overflow-hidden rounded-full bg-white/[0.06]"
        >
          <div
            className={cn("h-full rounded-full transition-[width] duration-500", share >= 1 ? "bg-warning" : "bg-primary")}
            style={{ width: `${share * 100}%` }}
          />
        </div>
        <span className="text-xs text-muted-foreground">
          {dateFormat.format(new Date(usage.periodStart))} – {dateFormat.format(lastDay)} (UTC). Resets on{" "}
          {dateFormat.format(new Date(usage.periodEnd))}.
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Agent runs" value={usage.runs} />
        <Stat label="Threads with runs" value={usage.threads} />
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-white/[0.03] px-4 py-3">
      <div className="text-2xl font-semibold tracking-tight">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

function PlanCard({ plan, current }: { plan: Plan; current: boolean }) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-2xl p-5 transition-[background-color,box-shadow] duration-300",
        current ? "bg-card shadow-glow" : "bg-card/60 shadow-soft hover:bg-card hover:shadow-glow",
      )}
    >
      <div className="mb-1 flex items-center justify-between">
        <h3 className="font-semibold">{plan.name}</h3>
        {current && <Badge variant="info">current</Badge>}
      </div>
      <div className="mb-4 flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold tracking-tight">{plan.price}</span>
        <span className="text-xs text-muted-foreground">{plan.period}</span>
      </div>
      <ul className="mb-5 flex-1 space-y-2">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-xs text-foreground/85">
            <Check className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            {feature}
          </li>
        ))}
      </ul>
      <Button variant={current ? "soft" : "default"} size="sm" disabled className="w-full">
        {current ? "Your plan" : "Coming soon"}
      </Button>
    </div>
  )
}
