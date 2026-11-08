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

Box credentials are held in memory by the box. Direct authentication verifies a box token and, on first use or a
credentials-version change, obtains credentials from the control plane. A restarted box has no such cache. The box token
also expires: neither an existing session nor a cached route is an unlimited offline credential. The host operator can
access the machine and its data; a VM is not a confidentiality boundary against its own operator.

## What different outages affect

| Event | Expected impact from current paths | What this does not establish |
| --- | --- | --- |
| Managed box unavailable | Its threads, files and runs are unavailable. A reachable user-owned box has its own state, but client discovery, token issuance and any shared control-plane features remain dependencies. | A managed user's data is not automatically migrated to a replacement box. |
| Control plane unavailable | New sign-ins, box discovery and token issuance, control-plane credentials, automation dispatch and relayed calls depend on it. Existing direct connections may continue while their token and cached credentials remain usable. | A fresh client or a restarted box cannot be assumed to work offline. |
| User-owned box unavailable | That box's local threads, files and runs cannot be reached; its disk and recovery are the owner's responsibility. | A managed box cannot reconstruct those local files merely from the registry. |
| Agent box restart | The box reloads persisted local state; work in flight is interrupted. Runtime credential and broker state must be rebuilt. | A restarted process is not the same as resuming an in-flight agent or desktop process. |
| Nest host loses control-plane lease | The host fence stops its VMs after lease expiry. The lease is a safety boundary, so a controller outage can affect running VMs even when the host itself is healthy. | Timeout alone does not prove it is safe to launch a second writable copy, or that the latest local data exists in a backup. |
| Nest host or disk loss | Host-local state may be inaccessible. Recovery depends on the available backup, its last successful completion and the controller's placement and fencing behavior. | The time a backup was started is not proof of a restorable recovery point or zero data loss. |

Automation and PR-watch definitions are currently stored and dispatched by the control plane and target managed or
legacy boxes; user-owned boxes do not yet have feature parity. Desktop media uses WebRTC, but signaling and connectivity
still depend on the route and configured network services. See [architecture.md](architecture.md#automations-and-pr-watches)
and [box.md](box.md#webrtc-desktop).

## Tests a resilience change needs

Choose the specific outage, state and contract before implementing a fallback. In particular:

1. Stop or isolate the managed box while a user-owned box is reachable; check which existing and new client actions
   work, and report unavailable threads rather than treating them as deleted.
2. Isolate the control plane with both a warm box and a newly restarted box. Test cached and expired tokens, credential
   version changes, a fresh client and recovery when the control plane returns.
3. Interrupt the box during a run and during delegated-result delivery. Check persisted state, user-visible outcome and
   whether any replay could duplicate an external action.
4. Partition a Nest host and delay or reorder lease, inventory and operation messages. Verify that no two writable owners
   can run, including after a controller restart or host reconnection.
5. Interrupt backup and restore, then restore from the last **completed** checkpoint. Report its timestamp and consistency;
   test missing or corrupt backup data rather than assuming a successful transfer.

These tests belong in isolated local stacks or fault-injection tests. Never perform outage tests against production.
