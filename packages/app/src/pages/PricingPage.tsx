import { motion } from "framer-motion"
import { ArrowRight, Check } from "lucide-react"
import { APP_URL, PublicShell } from "@/components/PublicShell"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const fadeInUp = { hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0, transition: { duration: 0.5 } } }
const staggerContainer = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.1 } } }

const plans = [
  {
    name: "Hobby",
    price: "$0",
    period: "forever",
    desc: "Try an agent box on a side project.",
    features: ["1 box, shared compute", "10 agent hours / month", "Live desktop at 720p", "Bring your own model key"],
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
  {
    q: "What exactly is a box?",
    a: "A machine we run for you, with a sandbox per agent run, a desktop per task, and the tools your agent needs already installed. You rent it the way you'd rent a game server.",
  },
  {
    q: "Do I pay for model usage here?",
    a: "No. Connect your own Anthropic or OpenAI key. Kestrel brokers it to the agent without ever exposing the key inside the sandbox.",
  },
  {
    q: "What counts as an agent hour?",
    a: "Wall-clock time an agent run is active on your box. Idle boxes and open desktops without a run don't count.",
  },
  {
    q: "Is billing live?",
    a: "Not yet. Kestrel is a hackathon demo. Plans show where the product is headed; everyone gets in free for now.",
  },
]

export function PricingPage() {
  return (
    <PublicShell pulse>
      <section className="relative z-10 px-8 pt-36 pb-16">
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
            Pricing
          </motion.h1>
          <motion.p variants={fadeInUp} className="mx-auto max-w-2xl text-lg text-muted-foreground">
            Rent the box, bring your own model key. No servers to manage, cancel anytime.
          </motion.p>
          <motion.div
            variants={fadeInUp}
            className="inline-flex items-center gap-2 rounded-full bg-white/[0.05] px-3 py-1 text-xs text-muted-foreground shadow-soft"
          >
            <span className="size-1.5 animate-pulse rounded-full bg-success" />
            Demo pricing. Billing is not live and every plan is free during the hackathon.
          </motion.div>
        </motion.div>
      </section>

      <section className="relative z-10 px-8 py-12">
        <div className="mx-auto grid max-w-6xl gap-6 md:grid-cols-3">
          {plans.map((plan, i) => (
            <motion.div
              key={plan.name}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.1, duration: 0.5 }}
              className={cn(
                "relative flex flex-col rounded-2xl p-8 transition-[background-color,box-shadow] duration-300",
                plan.highlight
                  ? "bg-card shadow-glow md:scale-[1.02]"
                  : "bg-card/60 shadow-soft hover:bg-card hover:shadow-glow",
              )}
            >
              {plan.highlight && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-1 text-[10px] font-semibold tracking-wider text-primary-foreground uppercase shadow-glow">
                  Most popular
                </div>
              )}
              <div className="mb-6">
                <h3 className="mb-2 text-xl font-semibold text-foreground">{plan.name}</h3>
                <p className="mb-4 text-sm text-muted-foreground">{plan.desc}</p>
                <div className="flex items-baseline gap-2">
                  <span className="text-4xl font-semibold tracking-tight text-foreground">{plan.price}</span>
                  <span className="text-sm text-muted-foreground">{plan.period}</span>
                </div>
              </div>
              <ul className="mb-8 flex-1 space-y-3">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-3 text-sm text-foreground/85">
                    <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    {feature}
                  </li>
                ))}
              </ul>
              <Button asChild variant={plan.highlight ? "default" : "soft"} className="h-10 w-full">
                <a href={APP_URL}>
                  {plan.cta} <ArrowRight />
                </a>
              </Button>
            </motion.div>
          ))}
        </div>
      </section>

      <section className="relative z-10 px-8 pt-20 pb-28">
        <div className="mx-auto max-w-3xl">
          <motion.h2
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            className="mb-8 text-center text-2xl font-semibold tracking-tight text-foreground"
          >
            Questions
          </motion.h2>
          <div className="space-y-3">
            {faqs.map((faq, i) => (
              <motion.div
                key={faq.q}
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.05 }}
                className="rounded-2xl bg-card/60 p-6 shadow-soft"
              >
                <h3 className="mb-2 text-base font-semibold text-foreground">{faq.q}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{faq.a}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>
    </PublicShell>
  )
}
