# State machines and transition contracts

**Status:** Wave 0 of the state-machine refactor. This document and the reference functions it names have no runtime
callers yet. It fixes the vocabulary, the decisions and the file ownership before the behaviour-changing PRs start.

The inventory that motivated this work found well over a hundred implicit lifecycles. Most are small caches or timers.
The material ones — where an illegal transition, a race, or a stale flag is observable — are marked **H** below. The
goal is not to put every cache in a statechart. It is to give every material lifecycle **one writer** and make its
illegal edges explicit.

## Vocabulary

| Term | Meaning here |
|---|---|
| **Phase** | The fields that together mean "where this thing is". A literal status, plus any flags that must agree with it. |
| **Event** | Something that happened: a user message, a run settling, a host report, a lease renewal. |
| **Writer** | The one function allowed to change a machine's phase for an event. |
| **Truth** | What the owner of the machine knows. For a VM, the host. For a thread, the box. |
| **Intent** | A request that has not happened yet: a pending command, a wake, a resume arm, a fire that must still run. |
| **Monotonic guard** | A value that only moves forward (`updatedAt`, `ownerEpoch`, a sequence), used to reject late writers. |
| **Durable intent** | Intent written before its side effect, so a crash either retries it or can see that it may have run. |
| **Idempotency key** | A stable id that makes repeating an external effect harmless. |

## Rules

1. **One writer per machine.** A phase may be changed only by its transition function (for example
   `transitionTask` in `packages/protocol/src/task-state.ts`). Callers prepare the event; they do not assign the
   fields themselves. A derived predicate (`isWorking`, `overStorage`, `hasPendingDelegations`) is a selector, not a
   second source of truth.
2. **Truth and intent are separate.** A `state` says what is true; a `pending*`, `wakeWanted` or arm says what should
   happen next. Never overwrite one with the other. When both disagree, the truth wins and the intent is re-derived.
3. **Write intent before the side effect, and clear it after.** If a crash between the two must be recoverable, the
   marker is the recovery input. The host's `operation` field and `recoverPlan` are the model.
4. **Every external effect gets an idempotency key.** Box calls, webhook fires, automation starts, broker grants,
   pairing collection, uploads. "At most once" is not a guarantee unless the key is durable.
5. **Protocol changes are additive and optional.** Control and boxes deploy independently, and old boxes keep running
   during a rollout. Do not change an existing field's meaning or make a new field required for decoding.
6. **A failed durable write is a rollback, not a partial success.** `StateStore.update` now restores memory when the
   write fails (PR #342). A caller that must proceed on an applied-but-unconfirmed write uses `updateOutcome`, and
   treats `unconfirmed` as applied.
7. **No behaviour change in Wave 0.** This PR adds types, tests and this document only.

## Decisions

These are the policy choices the refactor will implement. They are recorded here so parallel PRs do not invent
different answers. Change one here first, then in the code.

| # | Decision | Contract |
|---|---|---|
| D1 | A thread's phase has one authority | A live run's outcome wins. `task_report` is advisory until the run settles; a terminal report mid-run does not move the status. |
| D2 | `needs_input` always has a question | Only `task_ask` enters it. `report("needs_input")` without a pending ask is illegal; the MCP `working` word maps to `running`. |
| D3 | Pairing is single-use with a bounded same-id replay | The approved box secret is collected once and the row marked `used_at`. A poll with the same `pairingId` may repeat the same box and secret for a 60 s grace after the first collection (the CLI sends no separate collect token); the grace never extends the pairing's original `expires_at`, so the collectable window is the documented TTL plus that grace. Later polls, other ids and expiry return nothing. |
| D4 | Automation fires are idempotent | Persist the fire intent with a stable key (`automation_id` + scheduled instant, or the webhook delivery id). Repeating it returns the existing run. `next_run_at` advances only after the intent is durable. |
| D5 | Desktop `running` means lifecycle alive | Encoder presence is a separate `streaming` fact. `failed` means no live processes and no display users may attach to. |
| D6 | GPU state is level-triggered | The box stores the last host `GpuState`, reconciles it on reconnect, and gives `attaching` a deadline. A wish is intent; `GpuState` is truth. |
| D7 | Ending a session revokes its capabilities | Logout removes file, desktop, preview and box tokens minted from it. A capability never outlives the session that authorised it. |
| D8 | Delegation delivery and acknowledgement are separate | `deliveredAt` and `acknowledgedAt` are independent. An acknowledgement must never suppress an undelivered result. |
| D9 | Offline is read-only and own-box only | A user's own box may serve thread reads while control is unreachable and it holds no credentials; a managed box may not. No mutation, credential read or model call is served offline. |
| D10 | Stale-event guards are explicit | Every cross-process writer carries a monotonic guard (`updatedAt`, `ownerEpoch`, a generation) and rejects older values. |

## Ownership

Each Wave 1 PR owns its files exclusively. If a change is needed outside the list, the owner sends the hunk to the
owner of that file rather than editing it.

| Workstream | Exclusive files | Machines |
|---|---|---|
| `host-nest-correctness` | `packages/host/**`, `packages/control/src/nest-*` | host VM record/recovery/volume/GPU reservation; Nest VM, command, claim, wake, enrollment |
| `control-plane` | `packages/control/src/**` except `nest-*` | sessions, OAuth, pairing, capability tokens, TURN, relay/box sockets, fleet placement, automation, PR delivery, meter, hooks |
| `server-run-authority` | `packages/server/src/core/{service,harness,state,run-recovery,transcript}.ts` | task, run, ask, recovery arms, delegation, session resume, archive, admission, run entry, checkouts, uploads, quota |
| `server-desktop-gpu` | `packages/server/src/{desktop,platform,sandbox}/**`, `packages/server/src/http/streams.ts` | desktop session, encoder, GPU wish/link, WebRTC, RTP, viewer refcount, holders, systemd, audio |
| `server-tools` | `packages/server/src/{broker,mcp,cliauth,direct,relay,http}/**` except `http/streams.ts` | broker grant, MCP session, CLI login/accounts, stream adapters, direct auth (incl. offline), model discovery |
| `app-sync` | `packages/app/src/**` | live cache, reconnect, snapshot merge, desktop connection, pairing page, token cache, roster, settings queue |
| `mobile-desktop-clients` | `packages/mobile/src/**`, `packages/desktop/src/**` | mobile session/cache/tokens, Electron handoff and session stores, transcript bridge |

`service.ts` belongs to `server-run-authority`. A desktop change that needs a `CoreService` hunk lands after that PR,
or the hunk is supplied by the core owner.

## Wave 2

**Status:** Wave 1 is merged. Wave 2 extracts the remaining transition modules and migrates one writer per PR. It does
not change a call site's behaviour; when a migration exposes an illegal edge, the PR names the edge and either handles
it explicitly or leaves it as a documented log-and-continue until Wave 3.

**Pattern.** A pure `transitionX(phase, event)` lives in `packages/protocol/src` when the record is shared by the web
and phone clients; otherwise it lives in the owning package. It returns
`{ _tag: "transitioned", phase, changed }` or `{ _tag: "illegal", reason }` and never performs a side effect. A runtime
`applyXEvent` writes only the phase fields the transition owns, inside the caller's existing store update; records the
caller writes for its own reasons (messages, intents, counters) stay outside it.

Illegal transitions are asserted in the pure tests. The runtime logs the reason and continues; a development throw is
added to a domain only after its loud path has shipped for a release and the currently-landed edges are fixed. Do not
make a currently-landed edge fatal while the old direct writer is still the recovery path. Every migration PR names
the next writer it leaves and deletes the branch it replaced.

| Module | Pure transition | Runtime apply | First writer | Owner |
|---|---|---|---|---|
| `applyRunEvent` | `protocol/src/run-state.ts` | `server/src/core/run-state.ts` | `settleRun` | `server-run-authority` |
| `applyDelegationEvent` | `protocol/src/delegation-state.ts` | `server/src/core/delegation-state.ts` | `acknowledgeDelegation` | `server-run-authority` |
| `applyNestBoxEvent` | `control/src/nest-transition.ts` | `control/src/nest-fleet.ts` | VM report | `host-nest-correctness` |
| `applyDesktopEvent` | `server/src/desktop/desktop-state.ts` | `server/src/desktop/manager.ts` | `failSession` | `server-desktop-gpu` |
| `applyDeliveryEvent` | `control/src/delivery-state.ts` | `control/src/hub.ts` | `finishFire` | `control-plane` |

Sequence: archive/unarchive first through the existing `applyTaskEvent` (it now writes the archive field too), then
the run and delegation modules sequentially in `server-run-authority`; Nest, desktop and delivery proceed in parallel
on disjoint files. Keep `state.ts`'s task loop before its run loop: `taskPhaseOf` reads `run.status === "running"`, so
reordering it makes `restartReconcile` a no-op and breaks the restart tests.

Wave 3 remains client convergence: one reconnect owner, one desktop-cache writer, one working predicate, duplicate
merge helpers deleted. It starts after these modules land.

## Contract machines

### 1. Thread and run

**States:** `TaskStatus` (`idle | running | needs_input | done | failed`, `protocol/src/index.ts`) and `RunStatus`
(`running | succeeded | failed | cancelled`). Companion fields: `pendingAsks`, `archivedAt`, `usageLimitResume`,
`autoRetry`, `delegation`, `Run.endedAt`/`exitCode`/`interruptedByRestart`.

**Target writer:** `transitionTask` (`protocol/src/task-state.ts`) for the thread; one `settleRun` function for the
run and its thread, using `StateStore.updateOutcome` where the spawn must follow the reservation.

| From | Event | To | Guard |
|---|---|---|---|
| any non-archived | user message | `running` | clears the pending ask |
| `running` | `task_ask` | `needs_input` | live run, no question already waiting |
| `needs_input` | answer | `running` | a question exists |
| `running` | run succeeds | `done` | no pending ask |
| `running` | run fails | `failed` | no pending ask |
| `needs_input` | run settles | `needs_input` | the question is retained |
| `running` | cancel | `idle` | live run; drops its question |
| `running` | restart reconcile | `failed` | `interruptedByRestart` set |
| `needs_input` | restart reconcile | `needs_input` | retained ask |
| `needs_input` | delegation cancel | `idle` | question dropped |
| any | `task_report(done/failed)` while live | unchanged | advisory only |
| any | archive | same status, `archivedAt` set | teardown still cancels the run |

**Wave 1 status:** `report`, user messages and answers, `task_ask`, delegation cancel and restart reconciliation go
through `transitionTask`; `finish`, `stopRun` and `abort` share `settleRun`; an askless `needs_input` is normalized at
startup and `recordSession` ignores settled runs.

**Writer coverage:** every task phase write goes through `transitionTask`/`applyTaskEvent`, including startup repairs
and a delegated assignment that never dispatched. The literal `status: "idle"` on task creation is the only remaining
assignment. Runs settle and reconcile through `applyRunEvent`.

### 2. Nest VM, command and claim

**States:** `NestVmState` (`provisioning | running | suspended | parked | deleted`), `createFailed`, and the orthogonal
command state `pendingId/pendingKind/pendingDeadline`, plus the claim `hostId`/`ownerEpoch`/`vmId` and `wakeWanted`.

**Truth:** the host's `VmRecord` and its `NestVmReport`. **Intent:** the control row's `pending*`, `wakeWanted`, and the
enrollment token. `decideVm` (`control/src/nest-control.ts`) is the only central guard today; it decides apply/evict/ignore
for inbound reports only.

| From | Event | To | Guard |
|---|---|---|---|
| — | `createBox` | `provisioning` at epoch 1 | placement has room |
| `provisioning` | create result ok / report `running` | `running` | epoch, host, vm id match |
| `provisioning` | create failed / deadline | `provisioning` + `createFailed` | owner may delete |
| `running` | suspend | `suspended` | command settles; report is truth |
| `suspended` | resume | `running` | same host, or new placement at epoch+1 |
| `running`/`suspended` | park | `parked` | backup succeeded; claim released when no command is pending |
| `parked` | resume | `running` | new host allowed only after claim release |
| any | destroy ok | forgotten | `ownerEpoch` still valid |
| any report | epoch/host/vm match | report state | same-epoch report is truth |

**Wave 1 status:** evict commits its cause (`tombstone: "evict"`) and operation before releasing the VM and sends the
control epoch, so a crash in that window recovers without wiping the backup; an interrupted volume replacement is
rolled back from `.previous` on recovery; a stale freeze is cleared on recovery; and a refused enrollment send keeps
its token.

**Remaining gaps:** `vm()` accepts any state → any state; a failed create keeps a host claim with no pending command; a
parked box with a resume claim cannot move after its host is lost (the claim release is deliberately deferred until
the backup can be proven clean); `wakeWanted` and `pendingId` are separate retry mechanisms. PR #284 fixed the
hello/lease ordering, inventory/live-report ordering and park timeout; do not re-fix those.

### 3. Desktop session and encoder

**States:** `DesktopState` (`stopped | starting | running | failed`); `encoder` presence, `config`, `renderer`,
`ready`, `sinks`, `restartsLeft`; process-global `hardwareRender` and NVENC flags.

| From | Event | To | Guard |
|---|---|---|---|
| `stopped` | start | `starting` | no session, or `failed` session stopped first |
| `starting` | first H264 config | `running` | processes alive |
| `starting`/`running` | boot, encoder or input failure | `failed` | terminate processes, clear ready |
| `failed` | start | `starting` | previous session stopped |
| any | stop | `stopped` | session removed from the map |
| `running` | last viewer leaves | `running` | encoder idle after linger; state unchanged |

**Contract:** `running` does not mean “streaming”. Add `streaming` as an additive optional field in the desktop PR, and
treat a `failed` session as not attachable: a viewer must be refused with a retryable reason, not parked forever.

**Wave 1 status:** `streaming` is published when an encoder starts or stops; a failed session refuses viewers with a
retryable reason; the restart budget only earns credit after a stable live period or a served viewer.

**Remaining gaps:** `toStatus` keeps a `failed` session's display for diagnostics (viewers still cannot attach); NVENC
failures ban hardware for the whole process.

### 4. GPU wish and `GpuState`

**States:** no wish / one or more run wishes; host `GpuState = none | attaching | attached | detaching`; effective
renderer `gl | pixman` per session.

**Contract:** `GpuWishes` is intent; the last `GpuState` is truth and is stored by the box. On reconnect the box
reconciles both. `attaching` has a deadline and a visible status. Withdrawing the last wish is not the same as
releasing the GPU; only the host's `none`/`detaching` (or an explicit release reply) makes the renderer fall back.

**Wave 1 status:** the box stores the last `GpuState` and replays it on every guest-link reconnect; `attaching` keeps
one timestamp across reconnects and falls back at its deadline; a missed detach is reconciled instead of leaving
`hardwareRender` stale.

**Remaining gaps:** an attach after the 120 s request timeout still restarts desktops.

### 5. Delegation

**States:** `delegation { runId?, cancelledAt?, resultAcknowledged? }` plus deterministic message ids
(`delegation-result:<child>` and the question/recovery variants).

| From | Event | To |
|---|---|---|
| created | first run reserves | dispatched (`runId`) |
| dispatched | run settled, children settled, no arm | deliverable |
| deliverable | result message persisted | delivered |
| delivered | acknowledgement | acknowledged |
| any | cancel | cancelled |

**Contract:** delivery and acknowledgement are separate fields (D8). `acknowledgeDelegation` must not set a flag that
the delivery filter reads as “already delivered”. Cancellation is terminal; a later re-dispatch must clear or replace
the terminal flags deliberately.

**Wave 1 status:** delivery is decided by the deterministic result message, not the acknowledgement flag, so an ack
before the 2 s sweep no longer suppresses the result; `hasPendingDelegations` also waits for delivery, including a
settled continuation.

**Remaining gaps:** delivery is still gated by derived predicates across the run, its children and the continuation.
Run reservations, continuations and a re-link now go through the delegation writer; a re-link keeps cancellation and
clears only the old parent's acknowledgement.

### 6. Auth and capability tokens

**Machines:** session (`absent | live | expired | revoked`), OAuth state (`issued | consumed | expired`), pairing
(`pending | approved | collected | expired`), file/desktop/preview tokens (`minted | valid | expired | revoked`), and
direct box auth (`online | offline read-only`).

**Contract:** expiry is a state, not a missing row. OAuth state is validated before it is consumed. Pairing is collected
once (D3). Logout revokes every capability minted from the session (D7). Preview tokens are revoked with their task or
session, not left to a 24 h TTL. Offline auth (D9) is own-box, read-only, and ends the moment credentials return.

**Remaining gaps:** session expiry is enforced when a request reads the session, with no background sweep; the `cv`
version is derived from count + max(updated_at). Pairing now marks `used_at` before returning the secret, OAuth is
validated before its revision-keyed consume, and logout revokes preview tokens (Wave 1).

### 7. Automation and PR delivery

**Machines:** schedule (`enabled` × trigger × `nextRunAt`), fire (`claimed | started | failed | skipped`), PR watch
(`unwatched | watched`), activity queue (`queued | draining | retry | done`), webhook delivery (`unseen | seen`).

**Contract:** a fire is a durable intent with an idempotency key (D4). The alarm marks a fire claimed before calling the
box, records the outcome, and advances `nextRunAt` only after the claim is durable. A webhook delivery and its fire are
one unit. The PR queue has a retry bound and a terminal state; the box's `watching` mark is cleared by the same
operation that removes the control-plane row.

**Wave 1 status:** a fire is claimed with a stable key in the same transaction that advances `next_run_at`, the claim's
lease alarm is armed before the external call and rearmed on cold start, and a webhook delivery is written with its
fires. The PR queue has capped backoff and a terminal drop after five failures, and unwatch clears the box mark.

**Remaining gaps:** a crash between the box call and the recorded outcome can duplicate an external task start; the fire
is then failed after its lease instead of re-fired. Closing that fully needs an idempotency key on the box's
task-creation route.

### 8. Client sync and desktop connection

**Machines:** snapshot merge (pure helper `mergeSnapshot`), task event cache, stream reconnect, desktop `RtcState`
(`idle | connecting | live | retrying | unsupported`), viewer intent (`wanted | paused`), token cache.

**Contract:** every cache write that can lose a race carries a monotonic guard: `Task.updatedAt` is wall-clock (equal
timestamps land, and a delete leaves no tombstone), while item lists follow server order. Reconnect re-snapshots every
collection the stream can have missed, including `runItems`. One owner writes `keys.desktop(taskId)`: status frames
while a viewer's socket is delivering them, `desktop.updated` and REST snapshots otherwise, and a mutation response
only when nothing wrote after its `onMutate`. The RTC state is derived from its own events. There is one retry loop per
viewer: the stream layer reconnects a closed signalling socket at the later of the negotiation deadline and the 2 s
fallback, not an immediate loop that resets a 1→30 s backoff.

**Wave 1 status (mobile and Electron):** mobile task writes and snapshots carry the same monotonic guards, reconnect
invalidates cached `runItems`, the desktop cache has one reducer, `/api/me` results and late 401s are guarded by the
session generation, and the Electron handoff/queue is single-flight and serialized.

**Remaining gaps:** `DesktopStatus` carries no timestamp or version, so between two events, or two stream frames, the
later arrival wins; ordering is guaranteed only against the documented races above.

## Machine register

`H` = material correctness/security risk. `M` = material but bounded. `L` = cache/presentation. `closed` means the
current branch already fixed it; the row stays as the record of what was checked.

### Protocol and shared derivations

| Machine | Encoding | Phase |
|---|---|---|
| Live-item liveness | item order + parent tool status (`live-items.ts`) | M |
| Transcript segments | `afterItems` positions (`transcript-segments.ts`) | M |
| Desktop diagnostics text | derived from ~13 fields (`app/src/desktop/diagnostics.ts`) | L |
| Status presentation | `StatusIcon`, `RunSummary` | L |

### Control plane

| Machine | Encoding | Risk |
|---|---|---|
| Session + dev flag | row + `expires_at` + `dev` | H |
| OAuth state | row with revision; read, validate, consume | M |
| Pairing | `box_id` + `used_at` + `expires_at`; same-id 60 s grace | H |
| Automation schedule | `enabled` × trigger × `next_run_at` + durable `automation_fires` | H |
| Automation run | `started/failed` + nullable task/error | M |
| PR watch registry | `pr_watches` rows | M |
| PR activity queue + webhook dedupe | `due_at` + `delivery_id` + capped `attempts` | H |
| Meter ingest | `(host_id,event_id)` + owner pin | H |
| Meter reconciliation | inferred segments + derived status | M |
| File/desktop/preview tokens | TTL rows/Maps | M |
| TURN cache | durable per-identity generation + Worker cache | M |
| Box relay socket | random 31-bit id range + in-flight ids + path-keyed streams | H |
| Nest host socket | `{hello, retired}` attachment | M |
| Fleet placement | `pending/active/draining` + read-side assignment | M |
| Active-box routing | `active_box_id` + precedence | M |
| GitHub hook claim | CAS row | M |
| Connection `cv` | count + max(updated_at) | L |
| Activity snapshot | full-body UPSERT + stale predicate | L |
| Tool-failure counters | counter rows + retention | L |

### Nest control

| Machine | Encoding | Risk |
|---|---|---|
| VM state + `createFailed` | state column + flag | H |
| In-flight command | four `pending_*` columns + deadline | H |
| Host claim / epoch / vm id | `host_id`, `owner_epoch`, `vm_id` | H |
| Wake / lease | `wake_wanted` + `validUntil` + generation guards | H |
| Enrollment token | `enroll_hash` + `enroll_expires_at`; retained on a refused send | M |

### Server core

| Machine | Encoding | Risk |
|---|---|---|
| Task status | literal; `transitionTask` writer + documented exceptions | H |
| Run status | literal; `settleRun` owns the end state | H |
| Pending ask / live answer | `pendingAsks` + message-id-keyed `liveAsks` + token-guarded `askInFlight` | M-H |
| Recovery arms | `usageLimitResume` / `autoRetry` + `examined` + `settledRuns` | H |
| Delegation | optional fields + message ids; delivery and ack separate | H |
| Session resume | `runSessions` + provider/harness/continuation | M |
| Uploads | `uploads[]` + bytes | M |
| Storage quota | two in-memory maps + derived `overStorage` | M |
| Admission queue | `holding`/`waiting`/`startingItems`/`suspended` | H |
| Active run entry | `active` + `stopped` + driver | H |
| Archive / teardown | `archivedAt` + post-flag teardown | M |
| State migration / reconcile | field-presence + startup rewrite | M |
| Checkout / PR takeover | row+dir+shadow + ownership predicates | M |
| Transcript items | per-harness tool Maps | M |
| Driver turn outcome | three protocol latches | M |
| Text generation / title | one-shot child + baseline equality | L |
| Publish throttle / tool failures | held Map + timer; count Map | L |

### Server tools and runtime

| Machine | Encoding | Risk |
|---|---|---|
| MCP session/auth | one session per run; distinct-run per-user/global ceilings | M |
| Broker grant | `grantByToken` + `tokenByRun` Maps; live-run liveness on expiry | H |
| CLI page-login | per-user+provider semaphore + pending Map + `preparing` Set + marker | H |
| CLI account/caches | selection file + probes + TTL caches | M |
| Relay control link | socket/opened/backoff + in-flight HTTP ids + path-keyed streams | H |
| Stream adapter | open + pre-listener buffer | M |
| Desktop viewer config | `configSent` + signal queue | M |
| Stats sampler | `watched` + `sampling` + idle eviction | L |
| Direct auth | `absorbed`/`inFlight` + `offline` | M |
| Direct WebRTC channel | `closers` + opened/served | M |
| Model discovery | fingerprint + TTL + per-user lock | M |
| Activity reporter / misc caches | map/TTL/timer | L |

### Server desktop, platform and sandbox

| Machine | Encoding | Risk |
|---|---|---|
| Desktop session | `DesktopState` + session fields | H |
| Encoder | kind/initialized/restart budget (stable-period credit) + global NVENC flags | H |
| GPU wish / state / renderer | run Set + stored/replayed `GpuState` + attaching deadline + `hardwareRender` | H |
| Guest link | socket/backoff/wish/awaiting/enrolled | M-H |
| WebRTC peer | peer/live/viewToken/gathering/connection | M |
| RTP sender / tap | started/awaitingKey/queue/GOP | M |
| Viewer refcount / relaunch | `sinks` + `Relaunch` + `detachedSinks` | M |
| netns holder | `holders`/`starting` + `/proc` liveness | M-H |
| systemd scopes | runtime drop-ins + transient scopes | M |
| Desktop audio | server/capture/listener/restart budget | L |
| TURN cache | WeakMap + TTL + inflight | L |
| Toolkit install | filesystem-derived installed state | M |
| Activity tracker/socket | viewer gauge + path file | L |
| Box boot/shutdown + app registry | ordered boot; `exit === null` | L |

### Host

| Machine | Encoding | Risk |
|---|---|---|
| VM record / reported state | `state` + process/network/snapshot/volume fields | H |
| Crash recovery plan | explicit `recoverPlan(record, facts)` | H (inputs/application) |
| Operation marker | `operation{kind,from,startedAt}` + evict tombstone | M |
| Volume authority | `volumeRef/localRef/localDirty/backedUpAt` + `.previous` rollback | H |
| Freeze + snapshot generations | `frozen`, `snapshotGen` | H |
| Lazy volume service | `volumeProcess` + device + lock | M |
| GPU reservation / attach | `gpus[]`, `gpuAttachedAt`, in-memory reservations | M-H |
| Command outcomes | `commands.json`, generation fencing, `unrecorded` | M |
| Meter outbox | append/ack/reject, trim | M |
| Lease / fence | `lease.json` + watchdog | M |
| VM lock / process identity | pid+startTime+token | M |
| Meter intervals | `open` Map + derived event ids | L |
| Policy scale / template cache | `ScaleState`, keep-set | L |

### Web app

| Machine | Encoding | Risk |
|---|---|---|
| Task/run live cache | event → cache + `Task.updatedAt` guard | H |
| Stream reconnect | `disconnected` + `generation` + negotiation/2 s deadline | M-H |
| Snapshot merge | shared `mergeSnapshot` + identity/`updatedAt` guards | M |
| Desktop connection | `RtcState` + stream authority + one retry owner | H |
| Viewer visibility | `docVisible/onScreen/expired` + grace | L-M |
| Sidebar working/awaiting/archived | derived `running`/`needs_input` + `archivedAt` | M |
| Pairing page | poll + `expiresAt` + terminal approved/expired phase | M |
| Box data channel | pools + cooldown + generation | M |
| Box token cache | `tokens` + `minting` | M |
| Thread roster / active box | `taskBoxes` + stamped box list (PR #345) | M |
| Settings write queue | `saveState` + queue + pendingSaves | M |
| Model catalog | fallback/fresh/refreshing/error | M |
| Session expiry | listener + one-way `expired` | M |
| Gesture / held keys | per-pointer flags; down-state Map | M |
| CLI login UI | login+expired+code+completed+polling | M |
| Nest/fleet UI | state + `failed` + `pending`; freshness | L-M |

### Mobile and Electron

| Machine | Encoding | Risk |
|---|---|---|
| Mobile auth session | cookie × user × generation; expiry is a reported state | H |
| Mobile active box | `activeBoxId` × boxes × managed | M |
| Mobile live cache | shared `mergeSnapshot` + `Task.updatedAt` guard | H |
| Mobile settings queue | `saveState` + global pendingSaves | M |
| Mobile CLI login | login/expired/code/completed/polling | M |
| Mobile desktop viewer | embed/foreground/error + refresh | M |
| Mobile token caches | per-kind slots + timestamps | M |
| Electron handoff | single-use nonce + serial queue | H |
| Desktop session stores | file + in-memory copy under one serial queue | H |
| Transcript bridge | epoch/seq/patch | M |
| Window/updater/launch route | nullable window + library phases | M |

## Closed while this was written

These were findings in the inventory but `origin/main` already fixed them. Do not re-open them as Wave 1 work; the
remaining PRs must build on them.

| Finding | Fix on main |
|---|---|
| StateStore mutated memory before a failed write, with no rollback | #342: snapshot/restore, `updateOutcome` for applied-but-unconfirmed writes |
| Auto-retry retried runs a restart interrupted | #343: `interruptedByRestart` is neither armed nor retried |
| Host ran commands received before a disconnect or lease lapse | #344: connection/lease generations and in-memory outcomes |
| Nest resent commands before the lease; inventory could mix live reports; park timeout | #284: lease first, live report priority, park/retry state |
| Box list reads could overwrite a newer switch/removal | #345: stamped reads and changes; own-box offline reads |

## Verification

Wave 0:

```sh
bun run typecheck
bun test packages/protocol
```

Wave 1, per PR:

```sh
bun run typecheck
bun test <affected package>
bun run build:app     # if packages/app or packages/mobile changed
```

Then run the stack with a unique `KESTREL_DEV_SLOT` and exercise the flow the PR changes. The PR body records the
commands and what was observed. For cross-package changes, one integration branch merges every Wave 1 head and runs the
full typecheck, tests, build and the end-to-end flows before any PR merges.

Merging to `main` deploys and kills in-flight runs. Batch merges; do not merge seven PRs back-to-back.

## Out of scope

CSS transitions, pure literal enumerations with no writers, pure parsers/resolvers, and the existing explicit machines:
`recoverPlan`, `decideVm`, `claimHookRow`, the FLV demuxer and the driver `finish()` latches. Those are the pattern the
implicit machines should copy, not targets for rewrite.
