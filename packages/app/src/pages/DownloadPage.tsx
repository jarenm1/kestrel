import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { ArrowRight, Download, ExternalLink, Globe, Laptop, Monitor, Terminal } from "lucide-react"
import { queries, type DesktopAsset } from "@/api/queries"
import { KestrelMark } from "@/components/KestrelMark"
import { GITHUB_URL } from "@/components/PublicShell"
import { Button } from "@cloudagents/ui/button"
import { APP_HOME } from "@/routes"
import { cn } from "@/lib/utils"
import "@/stylesfrontend.css"

const PLATFORMS = [
  {
    id: "windows",
    name: "Windows",
    note: "Windows 10 and 11 · x64",
    icon: Monitor,
    extension: ".exe",
  },
  {
    id: "macos",
    name: "macOS",
    note: "Apple silicon · arm64",
    icon: Laptop,
    extension: ".dmg",
  },
  {
    id: "linux",
    name: "Linux",
    note: "Debian and Ubuntu · amd64",
    icon: Terminal,
    extension: ".deb",
  },
] as const

const megabytes = (bytes: number): string =>
  bytes > 0 ? `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB` : ""

function PlatformCard({
  name,
  note,
  icon: Icon,
  asset,
  pending,
  error,
}: {
  readonly name: string
  readonly note: string
  readonly icon: typeof Monitor
  readonly asset: DesktopAsset | undefined
  readonly pending: boolean
  readonly error: boolean
}) {
  return (
    <div className="flex flex-col rounded-2xl bg-card/60 p-6 shadow-soft transition-colors duration-300 hover:bg-card">
      <div className="mb-5 flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-xl bg-white/[0.06] text-foreground/85">
          <Icon className="size-5" />
        </span>
        <div>
          <h2 className="font-semibold tracking-tight text-foreground">{name}</h2>
          <p className="text-xs text-muted-foreground">{note}</p>
        </div>
      </div>
      <div className="mt-auto flex items-center gap-3">
        {asset !== undefined ? (
          <Button asChild className="h-9 flex-1">
            <a href={asset.url} download>
              <Download /> Download
            </a>
          </Button>
        ) : (
          <Button className="h-9 flex-1" disabled>
            {pending ? "Checking…" : error ? "Release unavailable" : "Coming soon"}
          </Button>
        )}
        {asset !== undefined && (
          <span className="text-xs text-muted-foreground tabular-nums">{megabytes(asset.size)}</span>
        )}
      </div>
    </div>
  )
}

/** Download page for approved users: the web app plus the platform installers published on `desktop-latest`. */
export function DownloadPage() {
  const release = useQuery(queries.desktopRelease())
  const assets = release.data?.assets ?? []
  const find = (extension: string): DesktopAsset | undefined =>
    assets.find((asset) => asset.name.toLowerCase().endsWith(extension))

  return (
    <div className="public-page relative flex min-h-screen flex-col overflow-x-hidden bg-background">
      <header className="fixed inset-x-0 top-4 z-50 flex justify-center px-4">
        <nav className="flex w-full max-w-5xl items-center gap-1 rounded-full bg-card/70 py-1.5 pr-1.5 pl-4 shadow-soft backdrop-blur-xl">
          <Link
            to={APP_HOME}
            aria-label="Kestrel home"
            className="mr-auto flex items-center gap-2.5 text-foreground/90 transition-colors duration-200 hover:text-foreground"
          >
            <KestrelMark className="h-5" />
            <span className="font-semibold tracking-tight max-sm:hidden">Kestrel</span>
          </Link>
          <Link
            to={APP_HOME}
            className="rounded-full px-3 py-1.5 text-muted-foreground transition-colors duration-200 hover:text-foreground"
          >
            Back to app
          </Link>
        </nav>
      </header>

      <section className="relative z-10 px-8 pt-36 pb-10">
        <div className="mx-auto max-w-4xl space-y-6 text-center">
          <h1 className="bg-[linear-gradient(180deg,#ffffff_0%,#ededef_45%,#8b8b93_100%)] bg-clip-text pb-2 text-4xl leading-[1.15] font-semibold tracking-tight text-transparent md:text-6xl">
            Kestrel Desktop
          </h1>
          <p className="mx-auto max-w-2xl text-lg text-muted-foreground">
            The same Kestrel, in its own window. Use the web app, or install the desktop build that updates itself from
            GitHub releases.
          </p>
        </div>
      </section>

      <section className="relative z-10 px-8 py-8">
        <div className="mx-auto max-w-6xl">
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col rounded-2xl bg-card/60 p-6 shadow-soft transition-colors duration-300 hover:bg-card">
              <div className="mb-5 flex items-center gap-3">
                <span className="grid size-10 place-items-center rounded-xl bg-white/[0.06] text-foreground/85">
                  <Globe className="size-5" />
                </span>
                <div>
                  <h2 className="font-semibold tracking-tight text-foreground">Web</h2>
                  <p className="text-xs text-muted-foreground">Nothing to install · always current</p>
                </div>
              </div>
              <div className="mt-auto">
                <Button asChild variant="soft" className="h-9 w-full">
                  <Link to={APP_HOME}>
                    Open Kestrel <ArrowRight />
                  </Link>
                </Button>
              </div>
            </div>
            {PLATFORMS.map((platform) => (
              <PlatformCard
                key={platform.id}
                name={platform.name}
                note={platform.note}
                icon={platform.icon}
                asset={find(platform.extension)}
                pending={release.isPending}
                error={release.isError}
              />
            ))}
          </div>

          <div
            className={cn(
              "mx-auto mt-8 flex max-w-3xl flex-col items-center gap-2 text-center text-sm text-muted-foreground",
              release.isError && "text-foreground/70",
            )}
          >
            <p>
              Linux ships as a <code className="font-mono text-xs">.deb</code> first. Windows and macOS installers appear
              here as their builds land; the desktop app updates from the{" "}
              <code className="font-mono text-xs">desktop-latest</code> release.
            </p>
            <a
              href={`${GITHUB_URL}/releases`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-foreground/70 transition-colors hover:text-foreground"
            >
              All releases <ExternalLink className="size-3.5" />
            </a>
          </div>
        </div>
      </section>
    </div>
  )
}
