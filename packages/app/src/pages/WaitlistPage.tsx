import { useState, type FormEvent } from "react"
import { useMutation } from "@tanstack/react-query"
import { motion } from "framer-motion"
import { ArrowRight, Check } from "lucide-react"
import { api } from "@/api/client"
import { Alert } from "@cloudagents/ui/alert"
import { Button } from "@cloudagents/ui/button"
import { Input } from "@/components/ui/input"
import { errorText } from "@/util"

const fadeInUp = { hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0, transition: { duration: 0.5 } } }

/** Public waitlist signup for the marketing site. */
export function WaitlistPage() {
  const [email, setEmail] = useState("")
  const signup = useMutation({ mutationFn: api.joinWaitlist })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    signup.mutate({ email: email.trim() })
  }

  return (
    <section className="relative z-10 px-8 pt-36 pb-28">
      <motion.div
        initial="hidden"
        animate="visible"
        variants={fadeInUp}
        className="relative mx-auto w-full max-w-xl overflow-hidden rounded-3xl bg-card px-8 py-14 text-center shadow-soft"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgb(255_255_255/0.08),transparent_60%)]"
        />
        <div className="relative space-y-6">
          <div className="space-y-3">
            <h1 className="text-3xl font-semibold tracking-tight text-foreground md:text-4xl">Join the waitlist</h1>
            <p className="text-base text-muted-foreground">
              Get early access to Kestrel. Leave your email and we&apos;ll let you know when your box is ready.
            </p>
          </div>
          {signup.isSuccess ? (
            <div className="flex items-center justify-center gap-2 rounded-2xl bg-white/[0.05] px-5 py-4 text-sm text-foreground">
              <Check className="size-4 text-muted-foreground" />
              You&apos;re on the list. We&apos;ll email {signup.data.email} when access opens.
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-3">
              <label className="sr-only" htmlFor="waitlist-email">
                Email address
              </label>
              <Input
                id="waitlist-email"
                type="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="h-11 text-base"
              />
              {signup.error && <Alert>{errorText(signup.error)}</Alert>}
              <Button type="submit" size="lg" className="h-11 w-full" disabled={signup.isPending}>
                {signup.isPending ? "Joining…" : "Join waitlist"} <ArrowRight />
              </Button>
            </form>
          )}
        </div>
      </motion.div>
    </section>
  )
}
