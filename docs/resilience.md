# Resilience and outage boundaries

This describes the current architecture and its failure boundaries, not an availability guarantee. The desired product
boundaries and planned work are in [goal-state.md](goal-state.md); the implemented paths are in
[architecture.md](architecture.md). A managed box, a user-owned box, the control plane and a Nest host can fail
independently. Recovering one does not automatically recover the others.

## Where state and authority live

| Component | State and responsibility | Failure boundary |
| --- | --- | --- |
| Control plane (Worker and Hub Durable Object) | Sessions, box registry and assignments, connection credentials, automations, PR watches, and relay and Nest fleet coordination | A working box does not replace sign-in, discovery, new box tokens or control-plane operations. |
| Agent box | Thread state, messages, runs, workspaces and files; agent harnesses, broker, desktop and direct box API | Losing a box makes its local threads and files unavailable. Assigning a user to another box does not copy that state. |
| User-owned box | The same box-side work, on the user's machine; its owner supplies and operates it | Its availability and disk durability are independent of the managed box. Its first authenticated request after a restart still needs control-plane credentials. |
| Nest host and VM | Host agent, local VM state and volumes; guest box runs inside the VM | A host outage is separate from an individual box process outage. A local VM or volume cannot be assumed recoverable on another host without a completed, usable backup and safe fencing. |
| Browser or mobile client | Session and cached client state, including direct-box routing and tokens where applicable | A cached route or token can permit some direct calls while the control plane is unreachable, but caches expire and a fresh client still needs discovery and authentication. |

Box credentials are held in memory by the box and arrive by two paths:

- **Direct requests** (`packages/server/src/direct/auth.ts`) verify a box token against the box secret without the control
  plane. The box fetches credentials from the control plane (`/box/self`, or `/box/credentials` for a managed box) when it
  has none cached for the token's user, or when the token carries a different credentials version (`cv`) and its `iat` is
  at or after the start of the last fetch. An older token cannot signal a newer version, so it does not trigger a refetch.
- **Relayed requests** carry the user's credentials in the `x-cloudagents-credentials` header on every request
  (`packages/control/src/hub.ts`, `packages/server/src/relay/client.ts`). The box stores them from the header and makes no
  credentials fetch. The relay itself still runs through the control plane.

A restarted box therefore starts with an empty cache: its first direct request needs the control plane, but a relayed one
does not need a separate fetch. The box token expires after one hour (`BOX_TOKEN_TTL_SECONDS`), so neither an existing
session nor a cached route is an unlimited offline credential. The host operator can access the machine and its data; a
VM is not a confidentiality boundary against its own operator.

## What different outages affect

| Event | Expected impact from current paths | What this does not establish |
| --- | --- | --- |
| Managed box unavailable | Its threads, files and runs are unavailable. A reachable user-owned box has its own state, but client discovery, token issuance and any shared control-plane features remain dependencies. | A managed user's data is not automatically migrated to a replacement box. |
| Control plane unavailable | New sign-ins, box discovery and token issuance, control-plane credentials, automation dispatch and relayed calls depend on it. Existing direct connections may continue while their token and cached credentials remain usable. | A fresh client or a restarted box cannot be assumed to work offline. |
| User-owned box unavailable | That box's local threads, files and runs cannot be reached; its disk and recovery are the owner's responsibility. | A managed box cannot reconstruct those local files merely from the registry. |
| Agent box crash | On restart, runs still marked `running` are marked `failed` with `interruptedByRestart`, and their tasks are marked `failed` (`packages/server/src/core/state.ts`). A delegated result whose parent run was interrupted is delivered again (see below). This describes current `main`. | A crash is not a graceful stop: nothing is cancelled first, and the user sees failed runs. This crash-vs-shutdown split is tied to current `main`; re-verify it when #343 lands. |
| Agent box graceful shutdown | On current `main`, SIGTERM reaches `harness.stopAll` (`packages/server/src/main.ts`): active runs are stopped as `cancelled` without `interruptedByRestart`, and a run with a pending question keeps that question. This describes current `main`; #343 changes graceful-restart behavior. | Graceful shutdown does not make a run resumable, and what a task's status looks like after the next start is not established here. Once #343 lands, this row is no longer valid until re-verified against its code; do not rely on it for restart outcomes before then. |
| Agent box restart by deploy | `box-auto` restarts the box with SIGTERM, so it takes the graceful-shutdown path above: active runs are stopped as `cancelled` without `interruptedByRestart`. Once its update has been deferred for `KESTREL_BOX_MAX_DEFER` (default 6 h), it restarts the box even with work running. This describes current `main`; #343 changes graceful-restart behavior. | A deploy restart is a graceful stop, not a crash: runs end `cancelled`, not `failed` with `interruptedByRestart`. Re-check this row after #343 merges. |
| Agent box restart (state) | Broker grants and per-run broker tokens live in memory and are lost. Credentials are re-established as described above. | A restarted process is not the same as resuming an in-flight agent or desktop process. |
| Box secret rotated | After `POST /api/fleet/boxes/:id/secret`, a box that has not restarted with the new secret rejects tokens minted under it and cannot fetch credentials. | Rotation is not transparent to a warm box. Rotate and restart together, when idle (see [box.md](box.md)). |
| Nest host loses control-plane lease | Each lease lasts 5 minutes (`NEST_LEASE_MS`). Past `validUntil` the host fence kills every running VM scope (`packages/host/src/fence.ts`), so a controller outage longer than about 5 minutes stops running VMs on every host, even healthy ones. A suspended box can wake on ingress only while the lease is valid. A parked box is started only by control: ingress at the host its URL names makes that host send `wakeRequest`, and control answers with a `resume`; no host starts it alone. | Timeout alone does not prove it is safe to launch a second writable copy, or that the latest local data exists in a backup. |
| Nest host or disk loss | Host-local state may be inaccessible. Recovery depends on the available backup, its last successful completion and the controller's placement and fencing behavior. Placement of a parked box with no claim does not wait for the old host to fence. | The time a backup was started is not proof of a restorable recovery point or zero data loss. Automatic re-placement is not a safe failover: a copy the old host started before it learned of the move runs until that host fences on lease expiry or evicts it on inventory. |

Automation and PR-watch definitions are currently stored and dispatched by the control plane and target managed or
legacy boxes; user-owned boxes do not yet have feature parity. Desktop media uses WebRTC, but signaling and connectivity
still depend on the route and configured network services. Managed TURN credentials are minted by the control plane for
one hour and cached there per box until five minutes before expiry (`packages/control/src/turn.ts`); a new desktop
connection after that needs the control plane. See [architecture.md](architecture.md#automations-and-pr-watches)
and [box.md](box.md#webrtc-desktop).

Nest fencing has two rules that are not yet one mechanism. The lease (`NEST_LEASE_MS`, 5 minutes) is enforced on the host.
The control plane's `NEST_FENCE_MARGIN_MS` (60 seconds) is defined in `packages/protocol/src/nest.ts` and described in
`docs/nest.md`, but no placement code reads it, so the margin is not enforced. A parked box whose resume claim is held by
a host that is offline waits for that host to reconnect; the wait has no deadline, and the box is not moved elsewhere.

## Tests a resilience change needs

Choose the specific outage, state and contract before implementing a fallback. In particular:

1. Stop or isolate the managed box while a user-owned box is reachable; check which existing and new client actions
   work, and report unavailable threads rather than treating them as deleted.
2. Isolate the control plane with both a warm box and a newly restarted box. Test cached and expired tokens, credential
   version changes (including an older token carrying a new version, which must not refetch), relayed and direct requests
   separately, a fresh client and recovery when the control plane returns. Rotate the box secret on a warm box: tokens
   minted under the new secret must be rejected until the box restarts with it.
3. Interrupt the box during a run and during delegated-result delivery. Compare a crash with a graceful shutdown. Check
   persisted state, user-visible outcome and whether any replay could duplicate an external action. Delegated-result
   delivery is at-least-once: a result persisted just before a restart is delivered again with the id
   `delegation-recovery:<child>:<run>` and the text "Check prior work before repeating side effects", and the earlier run
   may already have seen it.
4. Partition a Nest host and delay or reorder lease, inventory and operation messages. Verify that no two writable owners
   can run, including after a controller restart or host reconnection.
5. Interrupt backup and restore, then restore from the last **completed** checkpoint. Report its timestamp and consistency;
   test missing or corrupt backup data rather than assuming a successful transfer.

These tests belong in isolated local stacks or fault-injection tests. Never perform outage tests against production.
