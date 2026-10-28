import { useState, useRef, useEffect } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { Link } from "react-router-dom"
import { ControlPaths } from "@cloudagents/protocol"
import {
  Server, Monitor, Lock, Key, Terminal, Globe, ArrowRight,
  Play, X, MousePointer2, ShieldCheck, Zap, Cpu, Bot
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { SERVER_URL } from "@/config"
import "@/stylesfrontend.css"

export function KestrelIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
    <path d="M8 28C12 24 16 20 22 18C28 16 32 14 36 12C32 16 28 20 22 22C16 24 12 26 8 28Z" fill="currentColor" opacity="0.9" />
    <path d="M10 24C14 21 18 18 24 16C30 14 34 12 38 10C34 14 30 18 24 20C18 22 14 23 10 24Z" fill="currentColor" opacity="0.7" />
    <path d="M12 20C16 18 20 16 26 14C32 12 36 10 40 8C36 12 32 16 26 18C20 20 16 20 12 20Z" fill="currentColor" opacity="0.5" />
    <path d="M6 32C10 28 14 24 20 22C26 20 30 18 34 16C30 20 26 24 20 26C14 28 10 30 6 32Z" fill="currentColor" />
    </svg>
  )
}

const features = [
  {
    id: "desktop", icon: Monitor, title: "Live desktop streaming",
    desc: "Watch browsers and GUI apps in real time and take control.",
    demo: (
      <div className="w-full h-full bg-black/60 rounded-lg border border-white/10 flex flex-col overflow-hidden">
      <div className="h-8 bg-white/5 border-b border-white/10 flex items-center px-3 gap-2">
      <div className="flex gap-1.5">
      <div className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
      <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/80" />
      <div className="w-2.5 h-2.5 rounded-full bg-green-500/80" />
      </div>
      </div>
      <div className="flex-1 flex items-center justify-center p-6">
      <div className="text-center space-y-3">
      <MousePointer2 className="w-12 h-12 text-white mx-auto" />
      <p className="text-sm text-zinc-400">Live Stream Active</p>
      <div className="flex gap-2 justify-center">
      <span className="px-2 py-1 rounded bg-white/5 text-xs font-mono text-green-400">60 FPS</span>
      </div>
      </div>
      </div>
      </div>
    )
  },
{
  id: "sandbox", icon: Lock, title: "Sandboxed by default",
  desc: "Agents run in a locked-down sandbox with isolated namespaces.",
  demo: (
    <div className="w-full h-full bg-[#050505] rounded-lg border border-white/10 p-5 font-mono text-xs flex flex-col">
    <div className="text-green-400 mb-3">$ bubblewrap-exec --user</div>
    <div className="space-y-1.5 text-zinc-400">
    <p><span className="text-blue-400">[INFO]</span> Mounting worktree...</p>
    <p><span className="text-blue-400">[INFO]</span> Network isolated.</p>
    <p><span className="text-red-400">[DENIED]</span> Access /etc/shadow</p>
    <p className="animate-pulse text-green-400 mt-2">_</p>
    </div>
    </div>
  )
},
{
  id: "keys", icon: Key, title: "Keys never enter sandbox",
  desc: "Model keys stay with the host. Agents get short-lived tokens.",
  demo: (
    <div className="w-full h-full flex flex-col gap-3 p-4">
    <div className="p-3 rounded-lg bg-red-500/5 border border-red-500/20 flex items-center gap-3">
    <X className="w-5 h-5 text-red-400 shrink-0" />
    <p className="text-xs text-zinc-400">"Read API_KEY"</p>
    </div>
    <div className="flex justify-center"><ArrowRight className="w-4 h-4 text-zinc-600 rotate-90" /></div>
    <div className="p-3 rounded-lg bg-green-500/5 border border-green-500/20 flex items-center gap-3">
    <ShieldCheck className="w-5 h-5 text-green-400 shrink-0" />
    <p className="text-xs text-zinc-400">"Issued token: tk_8f9a..."</p>
    </div>
    </div>
  )
},
{
  id: "harness", icon: Terminal, title: "Bring your harness",
  desc: "Runs Claude Code out of the box. Any CLI agent works.",
  demo: (
    <div className="w-full h-full bg-black/60 rounded-lg border border-white/10 p-5 font-mono text-xs">
    <div className="flex items-center gap-2 mb-3 text-zinc-500 border-b border-white/5 pb-2">
    <Terminal className="w-3 h-3" />
    <span>execution</span>
    </div>
    <div className="space-y-2">
    <p><span className="text-purple-400">➜</span> claude-code --workspace</p>
    <p className="text-zinc-500">Initializing protocol...</p>
    <p className="text-green-400">✓ Connected.</p>
    </div>
    </div>
  )
},
{
  id: "tools", icon: Server, title: "Tools the agent needs",
  desc: "Built-in MCP server: screenshots, shell, and status reports.",
  demo: (
    <div className="w-full h-full grid grid-cols-2 gap-3 p-4">
    {["screenshot", "shell", "mouse", "fs"].map((tool, i) => (
      <div key={i} className="bg-white/[0.02] border border-white/5 rounded-lg p-3 flex flex-col justify-between">
      <span className="text-xs font-mono text-zinc-300">{tool}</span>
      <div className="w-full bg-white/10 h-1 rounded-full mt-2 overflow-hidden">
      <motion.div className="h-full bg-white" initial={{ width: "0%" }} animate={{ width: "100%" }} transition={{ duration: 2, repeat: Infinity, delay: i * 0.2 }} />
      </div>
      </div>
    ))}
    </div>
  )
},
{
  id: "reachable", icon: Globe, title: "Reachable anywhere",
  desc: "The box dials out to the control plane. No ports to expose.",
  demo: (
    <div className="w-full h-full flex items-center justify-center relative p-6">
    <div className="absolute inset-0 flex items-center justify-center">
    <motion.div className="w-24 h-24 rounded-full border border-white/10" animate={{ scale: [1, 1.2, 1], opacity: [0.5, 0, 0.5] }} transition={{ duration: 2.5, repeat: Infinity }} />
    </div>
    <div className="z-10 flex flex-col items-center gap-2">
    <Globe className="w-8 h-8 text-white" />
    <span className="text-xs font-mono text-zinc-400">Tunnel Active</span>
    </div>
    </div>
  )
}
]

const heroFeatures = [
  { icon: Zap, title: "Instant Environments", desc: "Secure dev boxes in seconds." },
{ icon: Cpu, title: "GPU at Scale", desc: "Access powerful GPUs for training." },
{ icon: Lock, title: "Isolated & Secure", desc: "Strong isolation, no key leaks." },
{ icon: Bot, title: "Built for Agents", desc: "Designed for autonomous workflows." },
]

const fadeInUp = { hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0, transition: { duration: 0.5 } } }
const slideInRight = { hidden: { opacity: 0, x: 40 }, visible: { opacity: 1, x: 0, transition: { duration: 0.6, delay: 0.2 } } }
const staggerContainer = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.1 } } }

export function LandingPage() {
  // Public pages are always the entry point; after GitHub auth the app home is `/repos`.
  const loginUrl = `${SERVER_URL}${ControlPaths.login}?return=${encodeURIComponent("/repos")}`

  const [activeFeature, setActiveFeature] = useState<number | null>(null)
  const featuresRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const id = activeFeature === null ? undefined : features[activeFeature]?.id
    if (id) {
      const timer = setTimeout(() => {
        const el = document.getElementById(`bento-${id}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [activeFeature]);

  const scrollToFeatures = () => featuresRef.current?.scrollIntoView({ behavior: "smooth" })

  const handleBentoClick = (index: number) => {
    if (activeFeature === index) {
      setActiveFeature(null)
    } else {
      setActiveFeature(null)
      setTimeout(() => setActiveFeature(index), 350)
    }
  }

  return (
    <div className="public-page flex min-h-screen flex-col relative overflow-x-hidden bg-gradient-to-b from-zinc-950 via-[#0a0a0f] to-black">
    <div className="public-noise fixed inset-0 opacity-[0.04] pointer-events-none z-0" />

    {/* HIGH-VISIBILITY, ZERO-COST VFX PATTERN */}
    <div className="public-vfx fixed inset-0 pointer-events-none z-0 opacity-70" />

    {/* ENHANCED VFX: Brighter, larger spotlight */}
    <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[800px] h-[600px] pointer-events-none z-0">
    <div className="absolute inset-0 bg-gradient-to-b from-white/[0.25] via-white/[0.1] to-transparent rounded-full blur-[120px]" />
    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[400px] h-[400px] bg-white/[0.15] rounded-full blur-[80px]" />
    </div>

    <nav className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-8 py-5 bg-black/40 backdrop-blur-xl border-b border-white/[0.04]">
    {/* Clickable Logo taking user to home screen */}
    <Link to="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
    <KestrelIcon className="w-6 h-6 text-white" />
    <span className="text-sm font-semibold tracking-[0.2em] text-white">KESTREL</span>
    </Link>
    <div className="flex items-center gap-6">
    <button onClick={scrollToFeatures} className="text-sm text-zinc-400 hover:text-white transition-colors">Product</button>
    <Link to="/pricing" className="text-sm text-zinc-400 hover:text-white transition-colors">Pricing</Link>
    <a href="https://github.com/StinkyCat0/kestrel" target="_blank" rel="noopener noreferrer" className="text-sm text-zinc-400 hover:text-white transition-colors">Docs</a>
    <Button asChild variant="soft" className="h-8 px-4 text-xs border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.08] rounded-md">
    <a href="/auth/dev-login">Dev Login</a>
    </Button>
    <Button asChild className="h-8 px-5 text-xs bg-white text-black hover:bg-zinc-200 rounded-md">
    <a href={loginUrl}>Get Started</a>
    </Button>
    </div>
    </nav>

    <section className="relative pt-32 pb-20 px-8 overflow-hidden z-10">
    <div className="max-w-7xl mx-auto relative z-10">
    <motion.div initial="hidden" animate="visible" variants={staggerContainer} className="grid lg:grid-cols-2 gap-12 items-center">
    <motion.div variants={fadeInUp} className="space-y-6">
    <div className="space-y-3">
    <p className="text-[10px] font-medium tracking-[0.35em] text-zinc-500 uppercase">Cloud Agents. Real Compute.</p>
    <h1 className="text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.15] pb-2 bg-[linear-gradient(180deg,#ffffff_0%,#f4f4f5_40%,#a1a1aa_100%)] bg-clip-text text-transparent">
    A secure home<br />for your agents.
    </h1>
    </div>
    <p className="text-base text-zinc-400 max-w-md leading-relaxed">
    Spin up isolated, GPU-powered environments for your agents. Develop, run, and scale with zero infrastructure friction.
    </p>
    <div className="flex items-center gap-4 pt-2">
    <Button asChild size="lg" className="h-10 px-6 text-sm bg-white text-black hover:bg-zinc-200 rounded-md">
    <a href={loginUrl}>Get Started <ArrowRight className="ml-2 h-4 w-4" /></a>
    </Button>
    <Button asChild variant="soft" size="lg" className="h-10 px-6 text-sm border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.08] rounded-md">
    <a href="https://github.com/StinkyCat0/kestrel" target="_blank" rel="noopener noreferrer">Read the Docs</a>
    </Button>
    </div>
    </motion.div>

    <motion.div variants={slideInRight} className="relative" style={{ perspective: "1000px" }}>
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] backdrop-blur-xl overflow-hidden shadow-2xl" style={{ transform: "rotateY(-8deg) rotateX(3deg)" }}>
    <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06] bg-black/40">
    <div className="flex items-center gap-2">
    <KestrelIcon className="w-3.5 h-3.5 text-white" />
    <span className="text-[10px] font-semibold tracking-wider text-white">KESTREL</span>
    </div>
    <div className="flex gap-1.5">
    <div className="w-2 h-2 rounded-full bg-zinc-700" />
    <div className="w-2 h-2 rounded-full bg-zinc-700" />
    <div className="w-2 h-2 rounded-full bg-zinc-700" />
    </div>
    </div>
    <div className="p-4 space-y-2">
    <div className="flex items-center justify-between mb-3">
    <h3 className="text-xs font-semibold text-white">Environments</h3>
    <button className="text-[10px] text-zinc-400 px-2 py-1 rounded border border-white/10">+ New</button>
    </div>
    {[
      { name: "research-agent", status: "Running", vcpu: "2 vCPU", ram: "16 GB" },
      { name: "sim-training", status: "Running", vcpu: "8 vCPU", ram: "64 GB" },
      { name: "data-pipeline", status: "Idle", vcpu: "4 vCPU", ram: "32 GB" },
    ].map((env, i) => (
      <div key={i} className="flex items-center justify-between p-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
      <div className="flex items-center gap-3">
      <div className="w-12 h-8 rounded bg-gradient-to-br from-zinc-800 to-zinc-900 border border-white/[0.05]" />
      <div>
      <p className="text-[11px] font-medium text-white font-mono">{env.name}</p>
      <p className="text-[9px] text-zinc-500">{env.vcpu} · {env.ram}</p>
      </div>
      </div>
      <div className="flex items-center gap-1.5">
      <div className={cn("w-1.5 h-1.5 rounded-full", env.status === "Running" ? "bg-green-400" : "bg-zinc-500")} />
      <span className="text-[9px] text-zinc-400">{env.status}</span>
      </div>
      </div>
    ))}
    </div>
    </div>
    </motion.div>
    </motion.div>

    <motion.div variants={fadeInUp} className="grid grid-cols-2 md:grid-cols-4 gap-8 mt-16 pt-10 border-t border-white/[0.04]">
    {heroFeatures.map((feature, i) => (
      <div key={i} className="space-y-2">
      <div className="h-8 w-8 rounded-lg bg-white/[0.03] border border-white/[0.06] flex items-center justify-center">
      <feature.icon className="w-4 h-4 text-zinc-300" />
      </div>
      <h3 className="text-sm font-semibold text-white">{feature.title}</h3>
      <p className="text-xs text-zinc-500 leading-relaxed">{feature.desc}</p>
      </div>
    ))}
    </motion.div>
    </div>
    </section>

    <section className="px-8 py-20 border-t border-white/[0.04] bg-black/20 relative z-10">
    <div className="max-w-5xl mx-auto">
    <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={staggerContainer} className="space-y-12">
    <motion.div variants={fadeInUp} className="text-center space-y-3">
    <h2 className="text-3xl font-bold tracking-tight text-white">How it works</h2>
    <p className="text-zinc-400 max-w-lg mx-auto text-sm">Like a game server you rent and mod, except the player is your coding agent.</p>
    </motion.div>

    <div className="relative flex flex-col md:flex-row justify-between items-start md:items-center gap-10 md:gap-8">
    <div className="hidden md:block absolute top-5 left-[10%] right-[10%] h-[1px] bg-gradient-to-r from-transparent via-white/10 to-transparent" />
    {[
      { step: "01", title: "Rent a box", desc: "Sign in with GitHub and get a dedicated agent box." },
      { step: "02", title: "Point at a repo", desc: "Every task gets its own git worktree and branch." },
      { step: "03", title: "Watch it work", desc: "Chat with the agent, stream desktop, review diffs." }
    ].map((item, i) => (
      <motion.div key={i} variants={fadeInUp} className="relative flex flex-col items-center text-center md:w-1/3 group">
      <div className="relative z-10 flex items-center justify-center w-10 h-10 rounded-full bg-zinc-900 border border-white/10 mb-4 backdrop-blur-md">
      <span className="text-xs font-bold text-white">{item.step}</span>
      </div>
      <h3 className="text-base font-semibold text-white mb-1.5">{item.title}</h3>
      <p className="text-xs text-zinc-400 max-w-[200px] leading-relaxed">{item.desc}</p>
      </motion.div>
    ))}
    </div>
    </motion.div>
    </div>
    </section>

    <section ref={featuresRef} id="features" className="px-8 py-20 relative z-10">
    <div className="max-w-7xl mx-auto w-full">
    <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={staggerContainer} className="space-y-10">
    <motion.div variants={fadeInUp} className="text-center space-y-3">
    <h2 className="text-3xl font-bold tracking-tight text-white">Everything the agent needs</h2>
    <p className="text-zinc-400 text-sm">Click any feature to see it in action.</p>
    </motion.div>

    <motion.div layout className="grid grid-cols-1 md:grid-cols-3 gap-5 w-full">
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
          "scroll-mt-32 group relative cursor-pointer overflow-hidden rounded-2xl border backdrop-blur-xl transition-colors",
          isActive
          ? "md:col-span-2 md:row-span-2 min-h-[550px] border-white/[0.12] bg-white/[0.05] ring-1 ring-white/[0.05]"
          : "col-span-1 border-white/[0.05] bg-white/[0.02] hover:bg-white/[0.04]"
        )}
        >
        <CardHeader className="pb-2 pt-6">
        <div className="flex items-start justify-between">
        <div className={cn(
          "h-10 w-10 rounded-lg flex items-center justify-center mb-3 transition-colors",
          isActive ? "bg-white/[0.08]" : "bg-white/[0.03] group-hover:bg-white/[0.06]"
        )}>
        <feature.icon className={cn("h-4 w-4", isActive ? "text-white" : "text-zinc-400 group-hover:text-white")} />
        </div>
        {isActive && (
          <button className="p-1 rounded-full bg-white/10 hover:bg-white/20" onClick={(e) => { e.stopPropagation(); setActiveFeature(null) }}>
          <X className="w-3 h-3 text-white" />
          </button>
        )}
        </div>
        <CardTitle className={cn("text-lg text-white", isActive && "text-xl")}>{feature.title}</CardTitle>
        </CardHeader>

        <CardContent className="flex flex-col h-full">
        <CardDescription className={cn("leading-relaxed mb-4 text-zinc-400 text-sm", isActive && "text-base text-zinc-300 max-w-md")}>
        {feature.desc}
        </CardDescription>

        <AnimatePresence mode="wait">
        {isActive && (
          <motion.div
          key="demo"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className="flex-1 w-full overflow-hidden rounded-lg border border-white/5 bg-black/20 p-4"
          >
          {feature.demo}
          </motion.div>
        )}
        </AnimatePresence>

        {!isActive && (
          <div className="mt-auto pt-3 flex items-center gap-1.5 text-[10px] font-medium text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity">
          <Play className="w-2.5 h-2.5" /> Click to expand
          </div>
        )}
        </CardContent>
        </motion.div>
      )
    })}
    </AnimatePresence>
    </motion.div>
    </motion.div>
    </div>
    </section>

    <section className="px-8 py-20 border-t border-white/[0.04] bg-gradient-to-b from-transparent to-black relative z-10">
    <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeInUp} className="max-w-2xl mx-auto text-center space-y-6">
    <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-white">Stop babysitting a VPS.</h2>
    <p className="text-base text-zinc-400">Sign in with GitHub, add a repo, and hand your agent its first task.</p>
    <Button asChild size="lg" className="h-12 px-8 text-base rounded-full bg-white text-black hover:bg-zinc-200">
    <a href={loginUrl}>Open the app</a>
    </Button>
    </motion.div>
    </section>
    </div>
  )
}
