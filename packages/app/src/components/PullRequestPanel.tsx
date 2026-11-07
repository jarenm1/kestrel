import { useQuery } from "@tanstack/react-query"
import { ExternalLink, GitPullRequest, RefreshCw } from "lucide-react"
import { Markdown } from "@cloudagents/ui/markdown"
import { Alert } from "@cloudagents/ui/alert"
import { Button } from "@cloudagents/ui/button"
import { api } from "@/api/client"
import { errorText } from "@/util"
import { CheckoutDiffSection } from "@/components/DiffPanel"

export type SelectedPr = { repo: string; number: number; url: string; label: string }

export function PullRequestPanel({ pr }: { pr: SelectedPr }) {
  const query = useQuery({ queryKey: ["pull-request", pr.repo, pr.number], queryFn: () => api.pullRequestDetail(pr.repo, pr.number) })
  const detail = query.data
  const timeline = detail ? [
    ...detail.comments.map((c) => ({ key: `comment-${c.id}`, author: c.author?.login ?? "Unknown", body: c.body, date: c.createdAt, action: "commented" })),
    ...detail.reviews.map((r) => ({ key: `review-${r.id}`, author: r.author?.login ?? "Unknown", body: r.body, date: r.submittedAt, action: r.state.toLowerCase().replaceAll("_", " ") })),
    ...detail.inlineComments.map((c) => ({ key: `inline-${c.id}`, author: c.author?.login ?? "Unknown", body: c.body, date: c.createdAt, action: `commented on ${c.path}${c.line ?? c.originalLine ? `:${c.line ?? c.originalLine}` : ""}` })),
  ].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "")) : []
  return <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 text-sm">
    <div className="mb-4 flex items-center justify-end gap-2">
      <Button variant="ghost" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCw /> Refresh</Button>
      <Button variant="ghost" size="sm" asChild><a href={pr.url} target="_blank" rel="noreferrer">GitHub <ExternalLink /></a></Button>
    </div>
    {query.isPending && <p className="text-muted-foreground">Loading pull request…</p>}
    {query.error && <Alert>{errorText(query.error)}</Alert>}
    {detail && <div className="space-y-5">
      <header className="space-y-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><GitPullRequest className="size-4" /> {pr.repo} #{detail.number}</div>
        <h2 className="text-xl font-semibold leading-tight">{detail.title}</h2>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded-full bg-success/15 px-2 py-1 font-medium text-success">{detail.draft ? "Draft" : detail.state}</span>
          <span>{detail.author?.login ?? "Unknown"}</span><span>·</span><span className="font-mono">{detail.head.ref} → {detail.base.ref}</span>
        </div>
      </header>
      {detail.body && <div className="rounded-xl bg-card p-4"><Markdown text={detail.body} /></div>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Info title="Reviewers" value={[...detail.requestedReviewers.flatMap((u) => u ? [u.login] : []), ...detail.requestedTeams.map((t) => t.name)].join(", ") || "None requested"} />
        <Info title="Contributors" value={detail.contributors.flatMap((u) => u ? [u.login] : []).join(", ") || "None found"} />
      </div>
      <section className="space-y-2"><h3 className="font-semibold">Checks</h3>
        {detail.checks.runs.length + detail.checks.statuses.length === 0 ? <p className="text-muted-foreground">No checks reported.</p> :
          <div className="rounded-xl bg-card p-3">{detail.checks.runs.map((c, i) => <CheckRow key={`${c.name}-${i}`} name={c.name} state={c.conclusion ?? c.status} url={c.url} />)}{detail.checks.statuses.map((s, i) => <CheckRow key={`${s.context}-${i}`} name={s.context} state={s.state} url={s.url} />)}</div>}
      </section>
      <section className="space-y-3"><h3 className="font-semibold">Conversation &amp; reviews</h3>
        {timeline.length === 0 && <p className="text-muted-foreground">No comments or reviews yet.</p>}
        {timeline.map((item) => <article key={item.key} className="rounded-xl bg-card p-4"><div className="mb-2 text-xs text-muted-foreground"><span className="font-semibold text-foreground">{item.author}</span> {item.action}{item.date && <> · <time dateTime={item.date}>{new Date(item.date).toLocaleString()}</time></>}</div>{item.body && <Markdown text={item.body} />}</article>)}
      </section>
      <section className="space-y-3"><h3 className="font-semibold">Files changed</h3><CheckoutDiffSection checkout={{ checkoutId: `${pr.repo}:${pr.number}`, repo: pr.repo, dir: "", baseBranch: detail.base.ref, diff: detail.diff }} /></section>
      {Object.values(detail.truncated).some(Boolean) && <p className="text-xs text-muted-foreground">Some results are truncated. Open GitHub to see the full history.</p>}
    </div>}
  </div>
}

function Info({ title, value }: { title: string; value: string }) {
  return <div className="rounded-xl bg-card p-3"><div className="mb-1 text-xs text-muted-foreground">{title}</div><div>{value}</div></div>
}

function CheckRow({ name, state, url }: { name: string; state: string; url: string | null }) {
  const content = <><span className="min-w-0 truncate">{name}</span><span className="ml-auto shrink-0 text-xs text-muted-foreground">{state.replaceAll("_", " ")}</span></>
  return url ? <a className="flex gap-3 py-1 hover:underline" href={url} target="_blank" rel="noreferrer">{content}</a> : <div className="flex gap-3 py-1">{content}</div>
}
