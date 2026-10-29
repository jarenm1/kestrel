import { lazy, Suspense, useEffect } from "react"
import { Link, NavLink, Outlet, useLocation } from "react-router-dom"
import { KestrelMark } from "@/components/KestrelMark"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { APP_ORIGIN } from "@/routes"
import "@/stylesfrontend.css"

// WebGL shader code only loads on the public pages.
const PublicBackground = lazy(() => import("@/components/PublicBackground"))

export const GITHUB_URL = "https://github.com/jarenm1/kestrel"

/** Where the public pages send people into the app; its root is the new chat (signed-out visitors sign in first). */
export const APP_URL = `${APP_ORIGIN}/`

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "rounded-full px-3 py-1.5 text-muted-foreground transition-colors duration-200 hover:text-foreground",
    isActive && "bg-white/[0.07] text-foreground",
  )

/**
 * Layout route for the public pages (landing, pricing): the app's theme with a bit more atmosphere (a greyscale
 * grain gradient behind the hero) and a floating pill nav. Both stay mounted while switching pages, so the
 * background keeps running instead of restarting.
 */
export function PublicShell() {
  const { pathname } = useLocation()

  // Page switches start at the top, like a full page load would. Block body: newer Chromium returns a Promise
  // from scrollTo, and React treats an effect's return value as its cleanup.
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])

  return (
    <div className="public-page relative flex min-h-screen flex-col overflow-x-hidden bg-background">
      {/* The gradient shows around the hero and fades to black towards the edges and further down the page. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[110vh] [mask-image:radial-gradient(ellipse_65%_60%_at_50%_35%,black_15%,transparent_100%)]"
      >
        <Suspense fallback={null}>
          <PublicBackground />
        </Suspense>
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
          <NavLink
            to="/"
            end
            className={(s) => cn(navLinkClass(s), "max-sm:hidden")}
            onClick={(e) => {
              // Already on the landing page: "Product" scrolls to the features.
              if (pathname !== "/") return
              e.preventDefault()
              document.getElementById("features")?.scrollIntoView({ behavior: "smooth" })
            }}
          >
            Product
          </NavLink>
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

      <Outlet />
    </div>
  )
}
