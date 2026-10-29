import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { ChevronsUpDown, CreditCard, LogOut, Plug, Settings } from "lucide-react"
import { queries } from "@/api/queries"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useSignOut } from "@/hooks/useSignOut"
import { cn } from "@/lib/utils"

function Avatar({ login, avatarUrl }: { login: string; avatarUrl: string }) {
  return (
    <span className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-full bg-white/[0.08] text-xs font-medium uppercase shadow-soft">
      {avatarUrl ? <img className="size-full" src={avatarUrl} alt="" /> : login.slice(0, 1)}
    </span>
  )
}

/**
 * The signed-in user at the foot of the threads strip; opens settings, its sections and sign-out. `compact` is the
 * collapsed rail: the avatar alone.
 */
export function AccountMenu({ compact = false }: { compact?: boolean }) {
  const me = useQuery(queries.me())
  const signOut = useSignOut()
  if (!me.data) return null
  const { login, name, avatarUrl } = me.data

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account"
        title={compact ? login : undefined}
        className={cn(
          "flex min-w-0 items-center gap-2.5 rounded-[0.5rem] text-muted-foreground transition-colors duration-200 outline-none hover:bg-white/[0.03] hover:text-foreground focus-visible:bg-white/[0.03] data-[state=open]:bg-white/[0.05] data-[state=open]:text-foreground",
          compact ? "justify-center py-1.5" : "w-full py-1.5 pr-2 pl-1.5",
        )}
      >
        <Avatar login={login} avatarUrl={avatarUrl} />
        {!compact && (
          <>
            <span className="min-w-0 flex-1 truncate text-left">{name ?? login}</span>
            <ChevronsUpDown className="size-4 shrink-0 opacity-60" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-56">
        <DropdownMenuLabel>
          Signed in as <span className="text-foreground">{login}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings/profile">
            <Settings />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/settings/connections">
            <Plug />
            Connections
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/settings/billing">
            <CreditCard />
            Billing
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={signOut.isPending} onSelect={() => signOut.mutate()}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
