import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CURRENT_PLAN, PLANS, type Plan, type Usage } from "@cloudagents/protocol"
import { motion } from "framer-motion"
import { ArrowRight, Check, CreditCard, ExternalLink, LogOut, User } from "lucide-react"
import { NavLink, Outlet, useNavigate } from "react-router-dom"
import { siteSignOut } from "@/api/client"
import { keys, queries } from "@/api/queries"
import { APP_URL } from "@/components/PublicShell"
import { Alert } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { errorText } from "@/util"

const fadeInUp = { hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0, transition: { duration: 0.5 } } }
const staggerContainer = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.1 } } }

const tabClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex items-center gap-2 rounded-full px-4 py-1.5 text-muted-foreground transition-colors duration-200 hover:text-foreground",
    isActive && "bg-white/[0.07] text-foreground",
  )

/** Panel on the public pages: the pricing cards' surface. */
function Panel({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className={cn("rounded-2xl bg-card/60 p-8 shadow-soft", className)}
    >
      {children}
    </motion.div>
  )
}

/**
 * Account pages on the public site (profile, billing). The session lives on the app host; the site reads it the way
 * the nav does, so a signed-out visitor gets a sign-in prompt instead of the pages.
 */
export function AccountLayout() {
  const me = useQuery(queries.publicMe())

  return (
    <>
      <section className="relative z-10 px-8 pt-36 pb-10">
        <motion.div
          initial="hidden"
          animate="visible"
          variants={staggerContainer}
          className="relative z-10 mx-auto max-w-4xl space-y-6 text-center"
        >
          <motion.h1
            variants={fadeInUp}
            className="bg-[linear-gradient(180deg,#ffffff_0%,#ededef_45%,#8b8b93_100%)] bg-clip-text pb-2 text-4xl leading-[1.15] font-semibold tracking-tight text-transparent md:text-6xl"
          >
            Account
          </motion.h1>
          <motion.p variants={fadeInUp} className="mx-auto max-w-2xl text-lg text-muted-foreground">
            Your profile, plan and agent usage.
          </motion.p>
          {me.data && (
            <motion.nav variants={fadeInUp} className="inline-flex gap-1 rounded-full bg-card/70 p-1 shadow-soft backdrop-blur-xl">
              <NavLink to="" end className={tabClass}>
                <User className="size-4" /> Profile
              </NavLink>
              <NavLink to="billing" className={tabClass}>
                <CreditCard className="size-4" /> Billing
              </NavLink>
            </motion.nav>
          )}
        </motion.div>
      </section>

      <section className="relative z-10 px-8 pb-28">
        <div className="mx-auto flex max-w-4xl flex-col gap-6">
          {me.isPending ? (
            <p className="text-center text-muted-foreground">Loading…</p>
          ) : me.data ? (
            <Outlet />
          ) : (
            <Panel className="flex flex-col items-center gap-4 text-center">
              <h2 className="text-xl font-semibold tracking-tight">Sign in to see your account</h2>
              <p className="max-w-md text-muted-foreground">Kestrel accounts come from GitHub. Sign in once and come back here.</p>
              <Button asChild className="h-10 px-6">
                <a href={APP_URL}>
                  Sign in with GitHub <ArrowRight />
                </a>
              </Button>
            </Panel>
          )}
        </div>
      </section>
    </>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 py-4">
      <span className="w-36 shrink-0 text-sm text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2 text-sm text-foreground/85">{children}</div>
    </div>
  )
}

export function ProfileSection() {
  const me = useQuery(queries.publicMe()).data
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const signOut = useMutation({
    mutationFn: siteSignOut,
    onSuccess: () => {
      queryClient.setQueryData(keys.publicMe, null)
      navigate("/")
    },
  })
  if (!me) return null

  return (
    <>
      <Panel className="flex flex-wrap items-center gap-5">
        <div className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-full bg-white/[0.08] text-xl font-semibold uppercase shadow-soft">
          {me.avatarUrl ? <img className="size-full" src={me.avatarUrl} alt="" /> : me.login.slice(0, 1)}
        </div>
        <div className="min-w-0">
          <div className="truncate text-xl font-semibold tracking-tight">{me.name ?? me.login}</div>
          <div className="truncate text-sm text-muted-foreground">@{me.login}</div>
        </div>
        <Button asChild variant="soft" className="ml-auto h-10">
          <a href={`https://github.com/${me.login}`} target="_blank" rel="noopener noreferrer">
            GitHub profile <ExternalLink />
          </a>
        </Button>
      </Panel>

      <Panel className="py-4">
        <div className="divide-y divide-white/[0.04]">
          <Row label="Name">{me.name ?? <span className="text-muted-foreground">Not set on GitHub</span>}</Row>
          <Row label="Username">{me.login}</Row>
          <Row label="Sign-in">GitHub. Name and avatar update each time you sign in.</Row>
          <Row label="Model keys">
            <span className="text-muted-foreground">Keys and subscriptions live in the app.</span>
            <Button asChild variant="soft" size="sm" className="ml-auto">
              <a href={`${APP_URL}connections`}>Connections</a>
            </Button>
          </Row>
        </div>
      </Panel>

      {signOut.error && <Alert>{errorText(signOut.error)}</Alert>}
      <div className="flex flex-wrap justify-center gap-3">
        <Button asChild className="h-10 px-6">
          <a href={APP_URL}>
            Open Kestrel <ArrowRight />
          </a>
        </Button>
        <Button variant="soft" className="h-10 px-6" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
          <LogOut /> Sign out
        </Button>
      </div>
    </>
  )
}

const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" })

function hours(seconds: number): string {
  const h = seconds / 3600
  if (h > 0 && h < 0.1) return "<0.1"
  return h < 10 ? h.toFixed(1) : Math.round(h).toString()
}

export function BillingSection() {
  const usage = useQuery(queries.usage())
  const current = PLANS.find((p) => p.id === CURRENT_PLAN)!

  return (
    <>
      <Panel className="bg-card shadow-glow">
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex flex-col gap-2">
            <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">Current plan</span>
            <h2 className="text-3xl font-semibold tracking-tight">{current.name}</h2>
            <p className="text-sm text-muted-foreground">{current.desc}</p>
          </div>
          <div className="ml-auto flex items-baseline gap-2">
            <span className="text-4xl font-semibold tracking-tight">{current.price}</span>
            <span className="text-sm text-muted-foreground">{current.period}</span>
          </div>
        </div>
        <div className="mt-8">
          {usage.error && <Alert>{errorText(usage.error)}</Alert>}
          {usage.isPending && <p className="text-sm text-muted-foreground">Loading usage…</p>}
          {usage.data && <UsageSummary usage={usage.data} plan={current} />}
        </div>
      </Panel>

      <div className="mt-6 text-center">
        <h2 className="text-2xl font-semibold tracking-tight">Plans</h2>
        <p className="mt-2 text-sm text-muted-foreground">Paid plans open when billing goes live; everyone is on Hobby for now.</p>
      </div>
      <div className="grid gap-6 md:grid-cols-3">
        {PLANS.map((plan, i) => (
          <PlanCard key={plan.id} plan={plan} current={plan.id === CURRENT_PLAN} delay={i * 0.1} />
        ))}
      </div>

      <Panel className="py-4">
        <div className="divide-y divide-white/[0.04]">
          <Row label="Payment method">
            <span className="text-muted-foreground">None. The Hobby plan needs no card.</span>
          </Row>
          <Row label="Invoices">
            <span className="text-muted-foreground">No invoices yet.</span>
          </Row>
        </div>
      </Panel>
    </>
  )
}

function UsageSummary({ usage, plan }: { usage: Usage; plan: Plan }) {
  const share = plan.agentHours === null ? 0 : Math.min(1, usage.agentSeconds / 3600 / plan.agentHours)
  const lastDay = new Date(Date.parse(usage.periodEnd) - 1)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium">Agent hours this month</span>
          <span className="text-sm text-muted-foreground">
            <span className="text-lg font-semibold text-foreground">{hours(usage.agentSeconds)}</span>
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
      <div className="grid grid-cols-2 gap-4">
        <Stat label="Agent runs" value={usage.runs} />
        <Stat label="Threads with runs" value={usage.threads} />
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl bg-white/[0.03] px-5 py-4">
      <div className="text-3xl font-semibold tracking-tight">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

function PlanCard({ plan, current, delay }: { plan: Plan; current: boolean; delay: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.5 }}
      className={cn(
        "relative flex flex-col rounded-2xl p-6 transition-[background-color,box-shadow] duration-300",
        current ? "bg-card shadow-glow" : "bg-card/60 shadow-soft hover:bg-card hover:shadow-glow",
      )}
    >
      {current && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-1 text-[10px] font-semibold tracking-wider text-primary-foreground uppercase shadow-glow">
          Your plan
        </div>
      )}
      <h3 className="mb-2 text-lg font-semibold">{plan.name}</h3>
      <div className="mb-5 flex items-baseline gap-2">
        <span className="text-3xl font-semibold tracking-tight">{plan.price}</span>
        <span className="text-xs text-muted-foreground">{plan.period}</span>
      </div>
      <ul className="mb-6 flex-1 space-y-2.5">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2.5 text-sm text-foreground/85">
            <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            {feature}
          </li>
        ))}
      </ul>
      <Button variant="soft" disabled className="h-10 w-full">
        {current ? "Current plan" : "Coming soon"}
      </Button>
    </motion.div>
  )
}
