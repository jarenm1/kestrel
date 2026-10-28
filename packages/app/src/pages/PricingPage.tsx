import { motion } from "framer-motion"
import { Link } from "react-router-dom"
import { ControlPaths } from "@cloudagents/protocol"
import { ArrowRight, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { SERVER_URL } from "@/config"
import { KestrelIcon } from "./LandingPage"
import "@/stylesfrontend.css"

const fadeInUp = { hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0, transition: { duration: 0.5 } } }
const staggerContainer = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.1 } } }

const plans = [
    {
        name: "Hobby",
        price: "$0",
        period: "forever",
        desc: "Try an agent box on a side project.",
        features: [
            "1 box, shared compute",
            "10 agent hours / month",
            "Live desktop at 720p",
            "Bring your own model key",
        ],
        cta: "Start free",
        highlight: false,
    },
{
    name: "Pro",
    price: "$29",
    period: "per month",
    desc: "A dedicated box for daily agent work.",
    features: [
        "1 dedicated box",
        "200 agent hours / month",
        "Live desktop at 1080p, 60 fps",
        "Parallel tasks with isolated worktrees",
        "Priority support",
    ],
    cta: "Go Pro",
    highlight: true,
},
{
    name: "Team",
    price: "$99",
    period: "per seat / month",
    desc: "Boxes for the whole team, managed in one place.",
    features: [
        "Dedicated box per seat",
        "Unlimited agent hours (fair use)",
        "GPU-accelerated desktops",
        "Shared repos and connections",
        "SSO and audit log",
    ],
    cta: "Contact us",
    highlight: false,
},
]

const faqs = [
    { q: "What exactly is a box?", a: "A machine we run for you, with a sandbox per agent run, a desktop per task, and the tools your agent needs already installed. You rent it the way you'd rent a game server." },
{ q: "Do I pay for model usage here?", a: "No. Connect your own Anthropic or OpenAI key. Kestrel brokers it to the agent without ever exposing the key inside the sandbox." },
{ q: "What counts as an agent hour?", a: "Wall-clock time an agent run is active on your box. Idle boxes and open desktops without a run don't count." },
{ q: "Is billing live?", a: "Not yet. Kestrel is a hackathon demo. Plans show where the product is headed; everyone gets in free for now." },
]

export function PricingPage() {
    // Public pages are always the entry point; after GitHub auth the app home is `/repos`.
    const loginUrl = `${SERVER_URL}${ControlPaths.login}?return=${encodeURIComponent("/repos")}`

    return (
        <div className="public-page flex min-h-screen flex-col relative overflow-x-hidden bg-gradient-to-b from-zinc-950 via-[#0a0a0f] to-black">
        {/* Subtle Noise Texture */}
        <div className="public-noise fixed inset-0 opacity-[0.04] pointer-events-none z-0" />

        {/* HIGH-VISIBILITY, ZERO-COST VFX PATTERN (Pure CSS, will never crash) */}
        <div className="public-vfx fixed inset-0 pointer-events-none z-0 opacity-70" />

        {/* Slowly Breathing Spotlight */}
        <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[800px] h-[600px] pointer-events-none z-0">
        <div
        className="absolute inset-0 bg-gradient-to-b from-white/[0.3] via-white/[0.12] to-transparent rounded-full blur-[100px]"
        style={{ animation: 'public-pulse 8s cubic-bezier(0.4, 0, 0.6, 1) infinite' }}
        />
        </div>

        {/* Nav */}
        <nav className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-8 py-5 bg-black/40 backdrop-blur-xl border-b border-white/[0.04]">
        <div className="flex items-center gap-3">
        <KestrelIcon className="w-6 h-6 text-white" />
        <span className="text-sm font-semibold tracking-[0.2em] text-white">KESTREL</span>
        </div>
        <div className="flex items-center gap-6">
        <Link to="/" className="text-sm text-zinc-400 hover:text-white transition-colors">Product</Link>
        <Link to="/pricing" className="text-sm text-white transition-colors">Pricing</Link>
        <a href="https://github.com/StinkyCat0/kestrel" target="_blank" rel="noopener noreferrer" className="text-sm text-zinc-400 hover:text-white transition-colors">Docs</a>
        <Button asChild variant="soft" className="h-8 px-4 text-xs border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.08] rounded-md">
        <a href="/auth/dev-login">Dev Login</a>
        </Button>
        <Button asChild className="h-8 px-5 text-xs bg-white text-black hover:bg-zinc-200 rounded-md">
        <a href={loginUrl}>Get Started</a>
        </Button>
        </div>
        </nav>

        {/* Hero */}
        <section className="relative pt-32 pb-16 px-8 z-10">
        <motion.div initial="hidden" animate="visible" variants={staggerContainer} className="max-w-4xl mx-auto text-center space-y-6 relative z-10">
        {/* FIX: Added leading-[1.15] and pb-2 to guarantee the 'g' is never clipped */}
        <motion.h1 variants={fadeInUp} className="text-4xl md:text-6xl font-bold tracking-tight leading-[1.15] pb-2 bg-[linear-gradient(180deg,#ffffff_0%,#f4f4f5_40%,#a1a1aa_100%)] bg-clip-text text-transparent">
        Pricing
        </motion.h1>
        <motion.p variants={fadeInUp} className="text-lg text-zinc-400 max-w-2xl mx-auto">
        Rent the box, bring your own model key. No servers to manage, cancel anytime.
        </motion.p>
        <motion.div variants={fadeInUp} className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.03] border border-white/10 text-xs text-zinc-400">
        <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
        Demo pricing. Billing is not live and every plan is free during the hackathon.
        </motion.div>
        </motion.div>
        </section>

        {/* Pricing Grid */}
        <section className="px-8 py-12 z-10">
        <div className="max-w-6xl mx-auto grid md:grid-cols-3 gap-6">
        {plans.map((plan, i) => (
            <motion.div
            key={plan.name}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.1, duration: 0.5 }}
            className={cn(
                "relative flex flex-col p-8 rounded-2xl border backdrop-blur-xl transition-all",
                plan.highlight
                ? "bg-white/[0.05] border-white/20 ring-1 ring-white/10 shadow-2xl scale-[1.02]"
                : "bg-white/[0.02] border-white/[0.05] hover:bg-white/[0.04]"
            )}
            >
            {plan.highlight && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-white text-black text-[10px] font-bold uppercase tracking-wider">
                Most popular
                </div>
            )}
            <div className="mb-6">
            <h3 className="text-xl font-semibold text-white mb-2">{plan.name}</h3>
            <p className="text-sm text-zinc-400 mb-4">{plan.desc}</p>
            <div className="flex items-baseline gap-2">
            <span className="text-4xl font-bold text-white">{plan.price}</span>
            <span className="text-sm text-zinc-500">{plan.period}</span>
            </div>
            </div>
            <ul className="space-y-3 mb-8 flex-1">
            {plan.features.map((feature, j) => (
                <li key={j} className="flex items-start gap-3 text-sm text-zinc-300">
                <Check className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
                {feature}
                </li>
            ))}
            </ul>
            <Button
            asChild
            className={cn(
                "w-full h-10 rounded-md transition-all",
                plan.highlight
                ? "bg-white text-black hover:bg-zinc-200"
                : "bg-white/[0.05] text-white border border-white/10 hover:bg-white/[0.1]"
            )}
            >
            <a href={loginUrl}>{plan.cta} <ArrowRight className="ml-2 h-4 w-4" /></a>
            </Button>
            </motion.div>
        ))}
        </div>
        </section>

        {/* FAQ */}
        <section className="px-8 py-20 border-t border-white/[0.04] relative z-10">
        <div className="max-w-3xl mx-auto">
        <motion.h2
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
        className="text-2xl font-bold text-white mb-8 text-center"
        >
        Questions
        </motion.h2>
        <div className="space-y-4">
        {faqs.map((faq, i) => (
            <motion.div
            key={i}
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: i * 0.05 }}
            className="p-6 rounded-xl bg-white/[0.02] border border-white/[0.05] backdrop-blur-sm"
            >
            <h3 className="text-base font-semibold text-white mb-2">{faq.q}</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">{faq.a}</p>
            </motion.div>
        ))}
        </div>
        </div>
        </section>
        </div>
    )
}
