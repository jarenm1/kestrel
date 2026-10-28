import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table data-slot="table" className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  )
}

function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("", className)} {...props} />
}

function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn("", className)} {...props} />
}

function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return <tr data-slot="table-row" className={cn("[&>td]:transition-colors [&>td]:duration-200 [&:hover>td]:bg-white/[0.04] [&>:first-child]:rounded-l-xl [&>:last-child]:rounded-r-xl", className)} {...props} />
}

function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn("h-9 whitespace-nowrap px-3 text-left align-middle text-xs font-medium text-muted-foreground", className)}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td data-slot="table-cell" className={cn("whitespace-nowrap px-3 py-2.5 align-middle", className)} {...props} />
}

export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow }
