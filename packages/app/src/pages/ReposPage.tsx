import { useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "react-router-dom"
import { api } from "@/api/client"
import { keys, queries } from "@/api/queries"
import { BoxOfflineBanner, useBoxOffline } from "@/components/BoxStatus"
import { GithubPicker } from "@/components/GithubPicker"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { errorText } from "@/util"

export function ReposPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const offline = useBoxOffline()
  const repos = useQuery(queries.repos())
  const [url, setUrl] = useState("")
  const [name, setName] = useState("")

  const addRepo = useMutation({
    mutationFn: api.addRepo,
    onSuccess: (repo) => {
      void queryClient.invalidateQueries({ queryKey: keys.repos })
      navigate(`/repos/${repo.id}`)
    },
  })
  const busy = addRepo.isPending

  function addByUrl(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    addRepo.mutate({ url: url.trim(), name: name.trim() || undefined })
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 overflow-auto p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Repositories</h1>
        <p className="text-muted-foreground">Repos cloned onto your agent box.</p>
      </div>
      <BoxOfflineBanner />
      {addRepo.error && <Alert>{errorText(addRepo.error)}</Alert>}

      <Card>
        <CardHeader>
          <CardTitle>Your repositories</CardTitle>
        </CardHeader>
        <CardContent>
          {repos.isPending && <div className="text-muted-foreground">Loading…</div>}
          {repos.error && <Alert>{errorText(repos.error)}</Alert>}
          {repos.data?.length === 0 && <div className="text-muted-foreground">No repositories yet.</div>}
          <ul className="-mx-2">
            {repos.data?.map((repo) => (
              <li key={repo.id}>
                <Link
                  to={`/repos/${repo.id}`}
                  className="flex items-baseline gap-3 rounded-xl px-2 py-2 transition-colors duration-200 hover:bg-white/[0.04]"
                >
                  <span className="font-medium">{repo.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">{repo.url}</span>
                </Link>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add from GitHub</CardTitle>
          <CardDescription>Your 100 most recently updated repositories.</CardDescription>
        </CardHeader>
        <CardContent>
          <GithubPicker
            disabled={busy || offline}
            onPick={(repo) => addRepo.mutate({ url: repo.cloneUrl, name: repo.fullName })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add by URL</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="flex flex-wrap gap-2" onSubmit={addByUrl}>
            <Input
              className="min-w-48 flex-1"
              type="url"
              required
              placeholder="Git clone URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Input
              className="min-w-48 flex-1"
              placeholder="Name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit" disabled={busy || offline || url.trim() === ""}>
              {busy ? "Cloning…" : "Add repo"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
