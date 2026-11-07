import { useState } from "react"
import type { Automation } from "@cloudagents/protocol"
import { Button } from "@cloudagents/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { automationImportUrl } from "@/lib/automationShare"
import { SHARE_ORIGIN } from "@/routes"

/** Shows the portable link for an automation; a recipient imports a disabled copy from it. */
export function ShareAutomationDialog({ automation, onClose }: { automation: Automation; onClose: () => void }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle")
  const link = automationImportUrl(SHARE_ORIGIN, automation)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setStatus("copied")
    } catch {
      setStatus("failed")
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        <DialogTitle>Share automation</DialogTitle>
        <DialogDescription>
          Anyone with this link can import a disabled copy of this automation. The link contains its prompt and trigger,
          so share it only with people you trust.
        </DialogDescription>
        <Input
          readOnly
          aria-label="Automation share link"
          value={link}
          onFocus={(e) => e.currentTarget.select()}
        />
        <p className="text-xs text-muted-foreground">
          {automation.repo === null
            ? "The imported copy has no repository; the recipient can pick one."
            : `The recipient picks one of their own repositories. ${automation.repo} is preselected when they can read it.`}
        </p>
        {status === "failed" && (
          <p className="text-sm text-error">Could not copy automatically. Select the link above and copy it.</p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button type="button" onClick={copy}>
            {status === "copied" ? "Copied" : "Copy link"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
