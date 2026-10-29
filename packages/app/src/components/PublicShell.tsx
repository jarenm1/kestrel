import type { ReactNode } from "react"
import { Link, NavLink } from "react-router-dom"
import { KestrelMark } from "@/components/KestrelMark"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { APP_ORIGIN } from "@/routes"
import "@/stylesfrontend.css"

export const GITHUB_URL = "https://github.com/jarenm1/kestrel"

/** Where the public pages send people into the app; its root is the new chat (signed-out visitors sign in first). */
export const APP_URL = `${APP_ORIGIN}/`

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "rounded-full px-3 py-1.5 text-muted-foreground transition-colors duration-200 hover:text-foreground",
    isActive && "bg-white/[0.07] text-foreground",
  )

/**
 * Frame for the public pages (landing, pricing): the app's theme with a bit more atmosphere (grid, grain and a
 * spotlight behind the hero) and a floating pill nav.
 */
export function PublicShell({
  children,
  onProductClick,
  pulse = false,
}: {
  children: ReactNode
  /** On the landing page, "Product" scrolls to the features instead of navigating. */
  onProductClick?: () => void
  /** Let the spotlight breathe slowly (pricing). */
  pulse?: boolean
}) {
  return (
    <div className="public-page relative flex min-h-screen flex-col overflow-x-hidden bg-background">
      <div aria-hidden className="public-vfx pointer-events-none fixed inset-0 z-0" />
      <div aria-hidden className="public-noise pointer-events-none fixed inset-0 z-0 opacity-[0.035]" />
      <div aria-hidden className="pointer-events-none fixed top-0 left-1/2 z-0 h-[600px] w-[900px] -translate-x-1/2">
        <div
          className="absolute inset-0 rounded-full bg-[radial-gradient(ellipse_at_top,rgb(255_255_255/0.16),transparent_65%)] blur-3xl"
          style={pulse ? { animation: "public-pulse 8s cubic-bezier(0.4, 0, 0.6, 1) infinite" } : undefined}
        />
      </div>

      <header className="fixed inset-x-0 top-4 z-50 flex justify-center px-4">
        <nav className="flex w-full max-w-5xl items-center gap-1 rounded-full bg-card/70 py-1.5 pr-1.5 pl-4 shadow-soft backdrop-blur-xl sm:gap-2">
          <Link
            to="/"
            aria-label="Kestrel home"
            className="mr-auto flex items-center gap-2.5 text-foreground/90 transition-colors duration-200 hover:text-foreground"
          >
            <KestrelMark className="h-5" />
            <span className="font-semibold tracking-tight max-sm:hidden">Kestrel</span>
          </Link>
          {onProductClick ? (
            <button
              type="button"
              onClick={onProductClick}
              className={cn(navLinkClass({ isActive: false }), "max-sm:hidden")}
            >
              Product
            </button>
          ) : (
            <NavLink to="/" end className={(s) => cn(navLinkClass(s), "max-sm:hidden")}>
              Product
            </NavLink>
          )}
          <NavLink to="/pricing" className={navLinkClass}>
            Pricing
          </NavLink>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(navLinkClass({ isActive: false }), "max-sm:hidden")}
          >
            Docs
          </a>
          {/* Dev-login exists only on local stacks (DEV_SESSION_LOGIN); production builds never show it. */}
          {import.meta.env.DEV && (
            <Button asChild variant="soft" size="sm" className="max-sm:hidden">
              <a href={`${APP_ORIGIN}/auth/dev-login`}>Dev Login</a>
            </Button>
          )}
          <Button asChild size="sm" className="ml-1 h-8 px-4">
            <a href={APP_URL}>Get Started</a>
          </Button>
        </nav>
      </header>

      {children}
    </div>
  )
}
