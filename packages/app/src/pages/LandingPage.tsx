import { useEffect, useRef, useState } from "react"
import { AnimatePresence, motion } from "framer-motion"
import {
  ArrowRight,
  ArrowUp,
  Bot,
  ChevronDown,
  Cpu,
  Globe,
  Key,
  Lock,
  Monitor,
  MousePointer2,
  Play,
  Server,
  ShieldCheck,
  SquarePen,
  Terminal,
  X,
  Zap,
} from "lucide-react"
import { KestrelMark } from "@/components/KestrelMark"
import { APP_URL, GITHUB_URL, PublicShell } from "@/components/PublicShell"
import { StatusIcon } from "@/components/StatusIcon"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** Inset panel inside an expanded feature card, styled like the app's code and desktop wells. */
const DEMO_WELL = "flex h-full w-full flex-col overflow-hidden rounded-xl bg-code shadow-well"

const features = [
  {
    id: "desktop",
    icon: Monitor,
    title: "Live desktop streaming",
    desc: "Watch browsers and GUI apps in real time and take control.",
    demo: (
      <div className={DEMO_WELL}>
        <div className="flex h-8 items-center gap-1.5 px-3">
          <div className="size-2 rounded-full bg-white/15" />
          <div className="size-2 rounded-full bg-white/15" />
          <div className="size-2 rounded-full bg-white/15" />
        </div>
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="space-y-3 text-center">
            <MousePointer2 className="mx-auto size-12 text-foreground" />
            <p className="text-sm text-muted-foreground">Live stream active</p>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-success/12 px-2.5 py-0.5 font-mono text-xs text-success">
              <span className="size-1.5 rounded-full bg-current" />
              1080p · 60 fps
            </span>
          </div>
        </div>
      </div>
    ),
  },
  {
    id: "sandbox",
    icon: Lock,
    title: "Sandboxed by default",
    desc: "Agents run in a locked-down sandbox with isolated namespaces.",
    demo: (
      <div className={cn(DEMO_WELL, "p-5 font-mono text-xs")}>
        <div className="mb-3 text-foreground">$ bubblewrap-exec --user</div>
        <div className="space-y-1.5 text-muted-foreground">
          <p>
            <span className="text-info">[info]</span> Mounting worktree…
          </p>
          <p>
            <span className="text-info">[info]</span> Network isolated.
          </p>
          <p>
            <span className="text-destructive">[denied]</span> Access /etc/shadow
          </p>
          <p className="mt-2 animate-pulse text-foreground">_</p>
        </div>
      </div>
    ),
  },
  {
    id: "keys",
    icon: Key,
    title: "Keys never enter sandbox",
    desc: "Model keys stay with the host. Agents get short-lived tokens.",
    demo: (
      <div className="flex h-full w-full flex-col justify-center gap-3 p-4">
        <div className="flex items-center gap-3 rounded-xl bg-destructive/10 p-3">
          <X className="size-5 shrink-0 text-destructive" />
          <p className="text-xs text-muted-foreground">"Read API_KEY"</p>
        </div>
        <div className="flex justify-center">
          <ArrowRight className="size-4 rotate-90 text-muted-foreground/60" />
        </div>
        <div className="flex items-center gap-3 rounded-xl bg-success/10 p-3">
          <ShieldCheck className="size-5 shrink-0 text-success" />
          <p className="text-xs text-muted-foreground">"Issued token: tk_8f9a…"</p>
        </div>
      </div>
    ),
  },
  {
    id: "harness",
    icon: Terminal,
    title: "Bring your harness",
    desc: "Runs Claude Code out of the box. Any CLI agent works.",
    demo: (
      <div className={cn(DEMO_WELL, "p-5 font-mono text-xs")}>
        <div className="mb-3 flex items-center gap-2 text-muted-foreground">
          <Terminal className="size-3" />
          <span>execution</span>
        </div>
        <div className="space-y-2">
          <p>
            <span className="text-muted-foreground">➜</span> claude-code --workspace
          </p>
          <p className="text-muted-foreground">Initializing protocol…</p>
          <p className="text-success">✓ Connected.</p>
        </div>
      </div>
    ),
  },
  {
    id: "tools",
    icon: Server,
    title: "Tools the agent needs",
    desc: "Built-in MCP server: screenshots, shell, and status reports.",
    demo: (
      <div className="grid h-full w-full grid-cols-2 gap-3 p-4">
        {["screenshot", "shell", "mouse", "fs"].map((tool, i) => (
          <div key={tool} className="flex flex-col justify-between rounded-xl bg-white/[0.04] p-3 shadow-soft">
            <span className="font-mono text-xs text-foreground/90">{tool}</span>
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/10">
              <motion.div
                className="h-full bg-foreground"
                initial={{ width: "0%" }}
                animate={{ width: "100%" }}
                transition={{ duration: 2, repeat: Infinity, delay: i * 0.2 }}
              />
            </div>
          </div>
        ))}
      </div>
    ),
  },
  {
    id: "reachable",
    icon: Globe,
    title: "Reachable anywhere",
    desc: "The box dials out to the control plane. No ports to expose.",
    demo: (
      <div className="relative flex h-full w-full items-center justify-center p-6">
        <div className="absolute inset-0 flex items-center justify-center">
          <motion.div
            className="size-24 rounded-full shadow-glow"
            animate={{ scale: [1, 1.25, 1], opacity: [0.6, 0, 0.6] }}
            transition={{ duration: 2.5, repeat: Infinity }}
          />
        </div>
        <div className="z-10 flex flex-col items-center gap-2">
          <Globe className="size-8 text-foreground" />
          <span className="font-mono text-xs text-muted-foreground">Tunnel active</span>
        </div>
      </div>
    ),
  },
]

const heroFeatures = [
  { icon: Zap, title: "Instant Environments", desc: "Secure dev boxes in seconds." },
  { icon: Cpu, title: "GPU at Scale", desc: "Access powerful GPUs for training." },
  { icon: Lock, title: "Isolated & Secure", desc: "Strong isolation, no key leaks." },
  { icon: Bot, title: "Built for Agents", desc: "Designed for autonomous workflows." },
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
  const [activeFeature, setActiveFeature] = useState<number | null>(null)
  const featuresRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const id = activeFeature === null ? undefined : features[activeFeature]?.id
    if (!id) return
    const timer = setTimeout(() => {
      document.getElementById(`bento-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
    }, 400)
    return () => clearTimeout(timer)
  }, [activeFeature])

  const handleBentoClick = (index: number) => {
    if (activeFeature === index) {
      setActiveFeature(null)
    } else {
      setActiveFeature(null)
      setTimeout(() => setActiveFeature(index), 350)
    }
  }

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
              <div className="space-y-4">
                <p className="inline-flex items-center gap-2 rounded-full bg-white/[0.05] px-3 py-1 text-xs text-muted-foreground shadow-soft">
                  <span className="size-1.5 rounded-full bg-success" />
                  Cloud agents. Real compute.
                </p>
                <h1 className="bg-[linear-gradient(180deg,#ffffff_0%,#ededef_45%,#8b8b93_100%)] bg-clip-text pb-2 text-5xl leading-[1.1] font-semibold tracking-tight text-transparent md:text-6xl lg:text-7xl">
                  A secure home
                  <br />
                  for your agents.
                </h1>
              </div>
              <p className="max-w-md text-base leading-relaxed text-muted-foreground">
                Spin up isolated, GPU-powered environments for your agents. Develop, run, and scale with zero
                infrastructure friction.
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

      <section className="relative z-10 px-8 py-20">
        <div className="mx-auto max-w-5xl">
          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            variants={staggerContainer}
            className="space-y-12"
          >
            <motion.div variants={fadeInUp} className="space-y-3 text-center">
              <h2 className="text-3xl font-semibold tracking-tight text-foreground">How it works</h2>
              <p className="mx-auto max-w-lg text-sm text-muted-foreground">
                Like a game server you rent and mod, except the player is your coding agent.
              </p>
            </motion.div>

            <div className="relative flex flex-col items-start justify-between gap-10 md:flex-row md:items-center md:gap-8">
              <div className="absolute top-5 right-[16%] left-[16%] hidden h-px bg-gradient-to-r from-transparent via-white/15 to-transparent md:block" />
              {[
                { step: "01", title: "Rent a box", desc: "Sign in with GitHub and get a dedicated agent box." },
                { step: "02", title: "Point at a repo", desc: "Every task gets its own git worktree and branch." },
                { step: "03", title: "Watch it work", desc: "Chat with the agent, stream desktop, review diffs." },
              ].map((item) => (
                <motion.div
                  key={item.step}
                  variants={fadeInUp}
                  className="relative flex flex-col items-center text-center md:w-1/3"
                >
                  <div className="relative z-10 mb-4 flex size-10 items-center justify-center rounded-full bg-card shadow-glow">
                    <span className="text-xs font-semibold text-foreground">{item.step}</span>
                  </div>
                  <h3 className="mb-1.5 text-base font-semibold text-foreground">{item.title}</h3>
                  <p className="max-w-[220px] text-xs leading-relaxed text-muted-foreground">{item.desc}</p>
                </motion.div>
              ))}
            </div>
          </motion.div>
        </div>
      </section>

      <section ref={featuresRef} id="features" className="relative z-10 scroll-mt-24 px-8 py-20">
        <div className="mx-auto w-full max-w-7xl">
          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            variants={staggerContainer}
            className="space-y-10"
          >
            <motion.div variants={fadeInUp} className="space-y-3 text-center">
              <h2 className="text-3xl font-semibold tracking-tight text-foreground">Everything the agent needs</h2>
              <p className="text-sm text-muted-foreground">Click any feature to see it in action.</p>
            </motion.div>

            <motion.div layout className="grid w-full grid-cols-1 gap-5 md:grid-cols-3">
              <AnimatePresence>
                {features.map((feature, i) => {
                  const isActive = activeFeature === i
                  return (
                    <motion.div
                      key={feature.id}
                      id={`bento-${feature.id}`}
                      layout
                      onClick={() => handleBentoClick(i)}
                      initial={{ opacity: 0, scale: 0.98 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.98 }}
                      transition={{ type: "spring", stiffness: 300, damping: 25 }}
                      className={cn(
                        "group relative flex scroll-mt-32 cursor-pointer flex-col overflow-hidden rounded-2xl p-6 transition-[background-color,box-shadow] duration-300",
                        isActive
                          ? "min-h-[550px] bg-card shadow-glow md:col-span-2 md:row-span-2"
                          : "col-span-1 bg-card/60 shadow-soft hover:bg-card hover:shadow-glow",
                      )}
                    >
                      <div className="flex items-start justify-between">
                        <div
                          className={cn(
                            "mb-4 flex size-10 items-center justify-center rounded-xl transition-colors",
                            isActive ? "bg-white/10" : "bg-white/[0.05] group-hover:bg-white/[0.08]",
                          )}
                        >
                          <feature.icon
                            className={cn(
                              "size-4",
                              isActive ? "text-foreground" : "text-muted-foreground group-hover:text-foreground",
                            )}
                          />
                        </div>
                        {isActive && (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Close"
                            onClick={(e) => {
                              e.stopPropagation()
                              setActiveFeature(null)
                            }}
                          >
                            <X />
                          </Button>
                        )}
                      </div>
                      <h3 className={cn("font-semibold text-foreground", isActive ? "text-xl" : "text-lg")}>
                        {feature.title}
                      </h3>
                      <p
                        className={cn(
                          "mt-1.5 mb-4 text-sm leading-relaxed text-muted-foreground",
                          isActive && "max-w-md text-base text-foreground/80",
                        )}
                      >
                        {feature.desc}
                      </p>

                      <AnimatePresence mode="wait">
                        {isActive && (
                          <motion.div
                            key="demo"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.3 }}
                            className="w-full flex-1 overflow-hidden rounded-xl bg-background/60 p-4 shadow-well"
                          >
                            {feature.demo}
                          </motion.div>
                        )}
                      </AnimatePresence>

                      {!isActive && (
                        <div className="mt-auto flex items-center gap-1.5 pt-3 text-[11px] font-medium text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                          <Play className="size-2.5" /> Click to expand
                        </div>
                      )}
                    </motion.div>
                  )
                })}
              </AnimatePresence>
            </motion.div>
          </motion.div>
        </div>
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
