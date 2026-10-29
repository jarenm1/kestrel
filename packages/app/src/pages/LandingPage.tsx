import { useRef } from "react"
import { motion } from "framer-motion"
import {
  ArrowRight,
  ArrowUp,
  ChevronDown,
  GitBranch,
  GitPullRequest,
  Globe,
  Key,
  Laptop,
  Lock,
  Monitor,
  Server,
  MonitorPlay,
  SquarePen,
  Terminal,
} from "lucide-react"
import { KestrelMark } from "@/components/KestrelMark"
import { APP_URL, GITHUB_URL, PublicShell } from "@/components/PublicShell"
import { StatusIcon } from "@/components/StatusIcon"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** What a box keeps from working locally. */
const heroFeatures = [
  { icon: GitBranch, title: "Your repo, your branches", desc: "Every thread works in its own git worktree and branch." },
  { icon: Terminal, title: "Your harness", desc: "Claude Code or Codex, signed in with your own account or key." },
  { icon: Laptop, title: "Keeps going", desc: "Runs on the box, not your laptop. Close the lid; it keeps working." },
  {
    icon: MonitorPlay,
    title: "Test builds anywhere",
    desc: "Run builds in a virtual desktop, and tell the agent what to change.",
  },
]

/** What the box adds on top. */
const features = [
  { icon: Monitor, title: "Live desktop", desc: "Watch browsers and GUI apps the agent drives, and take control." },
  { icon: Lock, title: "Sandboxed by default", desc: "Every run is locked into its own sandbox with only its worktree." },
  { icon: Key, title: "Keys stay outside", desc: "Model keys stay on the host; agents get short-lived tokens." },
  { icon: Server, title: "Tools built in", desc: "An MCP server for screenshots, the shell, questions and status." },
  { icon: GitPullRequest, title: "Diffs and PRs", desc: "Review the diff in the thread, or let the agent open the PR." },
  { icon: Globe, title: "No ports to open", desc: "The box dials out to the control plane, so it runs anywhere." },
]

const PREVIEW_THREADS = [
  { title: "Fix the flaky login test", status: "running", meta: "Working · just now", active: true },
  { title: "Add a dark mode toggle to settings", status: "done", meta: "Done · 12m ago", active: false },
  { title: "Bump dependencies", status: "needs_input", meta: "Needs input · 1h ago", active: false },
] as const

const fadeInUp = { hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0, transition: { duration: 0.5 } } }
const slideInRight = {
  hidden: { opacity: 0, x: 40 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.6, delay: 0.2 } },
}
const staggerContainer = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.1 } } }

/** A still of the real app: thread tabs on the left, the open thread in a raised panel with the composer. */
function AppPreview() {
  return (
    <div className="flex h-[400px] overflow-hidden rounded-2xl bg-background text-[13px] shadow-[0_40px_80px_-20px_rgb(0_0_0/0.9),0_0_0_1px_rgb(255_255_255/0.06),0_0_60px_-10px_rgb(255_255_255/0.08)]">
      <div className="hidden w-48 shrink-0 flex-col gap-0.5 py-3 pl-2 sm:flex">
        <div className="flex items-center gap-2 px-2.5 pb-3 text-foreground/90">
          <KestrelMark className="h-4" />
          <span className="text-xs font-medium">kestrel</span>
        </div>
        <div className="flex items-center gap-2.5 rounded-[0.5rem] px-2.5 py-2 text-muted-foreground">
          <SquarePen className="size-4" />
          New thread
        </div>
        <div className="px-2.5 pt-3 pb-1 text-[11px] text-muted-foreground">Threads</div>
        {PREVIEW_THREADS.map((t) => (
          <div
            key={t.title}
            className={cn(
              "flex min-w-0 items-start gap-2.5 rounded-[0.5rem] py-2 pr-3 pl-2.5 text-muted-foreground",
              t.active && "rounded-r-none bg-card text-foreground",
            )}
          >
            <StatusIcon status={t.status} className="mt-0.5" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]">
                {t.title}
              </span>
              <span className="text-[11px] text-muted-foreground">{t.meta}</span>
            </span>
          </div>
        ))}
      </div>
      <div className="my-2 mr-2 flex min-w-0 flex-1 flex-col rounded-xl bg-card shadow-soft sm:rounded-l-none">
        <div className="flex flex-1 flex-col gap-4 overflow-hidden px-5 pt-5">
          <div className="max-w-[85%] self-end rounded-2xl bg-white/[0.08] px-3.5 py-2 shadow-soft">
            The login test fails about one run in ten. Find out why and fix it.
          </div>
          <div className="space-y-2 text-foreground/90">
            <p>
              The test races the session cookie: it asserts before the redirect finishes. I'll wait on the{" "}
              <code className="rounded-md bg-white/[0.07] px-1.5 py-0.5 font-mono text-xs">/c</code> navigation
              instead of a fixed timeout.
            </p>
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground [&_svg]:size-3.5">
              <StatusIcon status="running" />
              Working…
            </div>
          </div>
        </div>
        <div className="p-3">
          <div className="flex flex-col gap-1 rounded-2xl bg-secondary p-2 shadow-soft">
            <div className="px-2 py-1.5 text-muted-foreground/70">Message the agent</div>
            <div className="flex items-center gap-1">
              {["Opus", "High"].map((label) => (
                <span
                  key={label}
                  className="inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-xs text-muted-foreground"
                >
                  {label}
                  <ChevronDown className="size-3.5 opacity-60" />
                </span>
              ))}
              <span className="ml-auto grid size-8 place-items-center rounded-full bg-primary text-primary-foreground shadow-soft">
                <ArrowUp className="size-4" />
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export function LandingPage() {
  const featuresRef = useRef<HTMLDivElement>(null)

  return (
    <PublicShell onProductClick={() => featuresRef.current?.scrollIntoView({ behavior: "smooth" })}>
      <section className="relative z-10 overflow-hidden px-8 pt-36 pb-20">
        <div className="relative z-10 mx-auto max-w-7xl">
          <motion.div
            initial="hidden"
            animate="visible"
            variants={staggerContainer}
            className="grid items-center gap-12 lg:grid-cols-2"
          >
            <motion.div variants={fadeInUp} className="space-y-6">
              <h1 className="bg-[linear-gradient(180deg,#ffffff_0%,#ededef_45%,#8b8b93_100%)] bg-clip-text pb-2 text-5xl leading-[1.1] font-semibold tracking-tight text-transparent md:text-6xl lg:text-7xl">
                A secure home
                <br />
                for your agents.
              </h1>
              <p className="max-w-md text-base leading-relaxed text-muted-foreground">
                Cloud agents with everything good about local: your repos, your subscriptions, and builds that run
                just like on your own machine. They just keep going when you close the laptop.
              </p>
              <div className="flex items-center gap-3 pt-2">
                <Button asChild size="lg">
                  <a href={APP_URL}>
                    Get Started <ArrowRight />
                  </a>
                </Button>
                <Button asChild variant="soft" size="lg">
                  <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
                    Read the Docs
                  </a>
                </Button>
              </div>
            </motion.div>

            <motion.div variants={slideInRight} className="relative" style={{ perspective: "1200px" }}>
              <div style={{ transform: "rotateY(-8deg) rotateX(3deg)" }}>
                <AppPreview />
              </div>
            </motion.div>
          </motion.div>

          <motion.div variants={fadeInUp} className="mt-20 grid grid-cols-2 gap-8 md:grid-cols-4">
            {heroFeatures.map((feature) => (
              <div key={feature.title} className="space-y-2">
                <div className="flex size-9 items-center justify-center rounded-xl bg-white/[0.05] shadow-soft">
                  <feature.icon className="size-4 text-foreground/90" />
                </div>
                <h3 className="text-sm font-semibold text-foreground">{feature.title}</h3>
                <p className="text-xs leading-relaxed text-muted-foreground">{feature.desc}</p>
              </div>
            ))}
          </motion.div>
        </div>
      </section>

      <section ref={featuresRef} id="features" className="relative z-10 scroll-mt-24 px-8 py-20">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={staggerContainer}
          className="mx-auto w-full max-w-6xl space-y-10"
        >
          <motion.div variants={fadeInUp} className="space-y-3 text-center">
            <h2 className="text-3xl font-semibold tracking-tight text-foreground">Everything the agent needs</h2>
            <p className="text-sm text-muted-foreground">What the box adds on top of your local setup.</p>
          </motion.div>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 md:grid-cols-3">
            {features.map((feature) => (
              <motion.div key={feature.title} variants={fadeInUp} className="rounded-2xl bg-card/60 p-6 shadow-soft">
                <div className="mb-4 flex size-10 items-center justify-center rounded-xl bg-white/[0.05]">
                  <feature.icon className="size-4 text-foreground/90" />
                </div>
                <h3 className="text-lg font-semibold text-foreground">{feature.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{feature.desc}</p>
              </motion.div>
            ))}
          </div>
        </motion.div>
      </section>

      <section className="relative z-10 px-8 pt-20 pb-28">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={fadeInUp}
          className="relative mx-auto max-w-3xl overflow-hidden rounded-3xl bg-card px-8 py-16 text-center shadow-soft"
        >
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgb(255_255_255/0.08),transparent_60%)]"
          />
          <div className="relative space-y-6">
            {/* The glow sits on a wrapper: a filter on the masked mark itself would be clipped by the mask. */}
            <div className="flex justify-center drop-shadow-[0_0_24px_rgb(255_255_255/0.25)]">
              <KestrelMark className="h-10 text-foreground" />
            </div>
            <h2 className="text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
              Stop babysitting a VPS.
            </h2>
            <p className="text-base text-muted-foreground">
              Sign in with GitHub, add a repo, and hand your agent its first task.
            </p>
            <Button asChild size="lg">
              <a href={APP_URL}>Open the app</a>
            </Button>
          </div>
        </motion.div>
      </section>
    </PublicShell>
  )
}
