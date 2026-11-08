# Nest rollout: taking production Nest-only

PR #349 makes the Nest the only hosted-box path: it deletes `managed_boxes`, the box↔control relay and the
`cloudagents-box-auto` flake app, and adds `Hub.ensureNestBox` (packages/control/src/hub.ts), which creates a Nest box
for any signed-in user with zero `user_boxes` the first time their app calls `GET /api/boxes` (`listBoxes` →
`ensureProvisioned`) or anything that reaches `boxCall` (`callTarget`). Design and contracts: [nest.md](nest.md).

Merging #349 with no Nest host connected — or with `KESTREL_NEST_DOMAIN` unset — takes every user offline: there is
no managed fallback left in the code. This runbook is the order of operations that avoids that.

Placeholders below: `<nest-domain>` is the domain boxes are served under, `<slug>` the host's DNS label, `<host-id>`
the id control issues at registration, `<worker>` the production Worker origin (`app.kestrel-agent.com`, or its
workers.dev name — `workers_dev` stays on because boxes dial it, wrangler.jsonc).

## 0. Before you start

- Your GitHub login is in the Worker's `KESTREL_OPERATORS`: the operator routes used below (`/api/meter/hosts`,
  `/api/nest/hosts`) answer 404 to anyone else (`handleMeter`, `handleNest`, packages/control/src/api.ts;
  `isOperator`, packages/control/src/env.ts). The examples use a `session` cookie from a signed-in operator.
- A bare-metal x86_64 machine with KVM, public reachability on TCP 22/80/443 (the module's `inet kestrel` firewall
  accepts those), and `/var/lib/kestrel-host` on a reflink filesystem — XFS; `kestrel-volume backup` reflinks with
  `FICLONE` and has no copy fallback (nest.md, "Storage").
- An object-storage bucket for volume backups (R2 in production) and an access key for it.
- DNS provider API access covering `<nest-domain>`'s zone: Caddy gets the wildcard certificate by DNS-01.
- Time to file the Public Suffix List request — see step 1; it is the only step with an external queue.

## 1. Pick the domain; put it on the PSL

Every box is served as `https://<boxId>.<slug>.<nest-domain>` (`publicUrlFor`,
packages/control/src/nest-control.ts). `<nest-domain>` must be on the Public Suffix List — otherwise a page on
`box-a.<slug>.<nest-domain>` can set a cookie that `box-b.<slug>.<nest-domain>` receives (nest.md, "Security"; the
only alternative is boxes restricted to host-only `__Host-` cookies). File the request first; everything else here is
under your control.

## 2. Register the host with control

Registration is a meter-host registration and works on the deployed Worker today — it does not depend on
`KESTREL_NEST_DOMAIN` (`handleMeter` does not check it):

```sh
curl -X POST https://app.kestrel-agent.com/api/meter/hosts \
  --cookie 'session=<operator session cookie>' \
  -H 'content-type: application/json' \
  -d '{"name":"<slug>"}'
# -> 201 { "host": { "id": "<host-id>", "name": "<slug>", "createdAt": "…" }, "secret": "<host secret>" }
```

The `secret` is returned only here (`createMeterHost`, hub.ts). Keep it for `/etc/kestrel-host/host-secret` (step 3)
and record `<host-id>`: the host proves itself with `Authorization: Bearer <secret>` and the id in
`x-kestrel-nest-host` (`acceptNestHost`, hub.ts). The module's `hostId` defaults to `slug` — set it to `<host-id>`
explicitly, or every connect gets 401.

DNS (nest.md, "Operations"): create `*.<slug>.<nest-domain>` A/AAAA to the host's public address. If `<nest-domain>`
is not served by the provider the DNS-01 credentials can write, CNAME `_acme-challenge.<slug>.<nest-domain>` to a
zone they can.

## 3. Build and boot the host

NixOS, importing the flake's `nixosModules.nest-host` module (flake.nix; the module is
packages/host/nix/host-module.nix — the option names below are its real ones):

```nix
services.kestrel-nest = {
  enable = true;
  slug = "<slug>";
  hostId = "<host-id>";                        # the registration id, not the slug
  domain = "<nest-domain>";
  controlUrl = "wss://app.kestrel-agent.com";  # ws(s); the same URL reaches guests as CLOUDAGENTS_CONTROL_URL
  meterUrl = "https://app.kestrel-agent.com";  # https origin for meter batches
  uplink = "<uplink iface>";                   # interface guests reach the internet through (masqueraded)
  cpuVendor = "amd";                           # or "intel"; picks the IOMMU kernel parameters
  capacity = { vcpus = <n>; memoryBytes = <n>; };            # what the host offers VMs
  template = { maxVcpus = <n>; maxMemoryBytes = <n>; };      # per-VM ceiling, above the 1 GiB boot
  volumeStore = "s3://<bucket>/<prefix>";
  acme.dnsProvider = "cloudflare";             # or "route53"
  nixCache.publicKey = "<key name>:<base64>";  # public half of the cache signing key
};
```

The module wires: `kestrel-host.service` (`kestrel-host daemon --config /etc/kestrel-host/config.json`, which the
module renders), `kestrel-fence.service` (the lease watchdog), `kestrel-ingress` behind Caddy on `127.0.0.1:8081`,
`kestrel-depcache` and a static Nix cache on `169.254.0.1`, unbound for guest DNS, the `inet kestrel` nftables table
plus NAT, `kestrel-vms.slice`, the IOMMU/`vfio-pci` kernel parameters and modules, and Caddy serving
`*.<slug>.<domain>` with a DNS-01 certificate.

Files under `/etc/kestrel-host` (the module creates it 0700; keep contents 0600 root):

| File | Set by | Contents |
|---|---|---|
| `host-secret` | `hostSecretFile` default | The `secret` from step 2, trimmed (`readHostSecret`, packages/host/src/config.ts) |
| `volume.key` | `volumeKeyFile` default | The fleet volume key — 32 raw bytes or 64 hex chars, owner-only mode (`FleetKey::load`, packages/host/crates/volume/src/crypto.rs). One key for the whole fleet: every host must hold the same one, or a parked box resumed on another host cannot open its backups. Generate once: `openssl rand -hex 32` |
| `caddy.env` | `acme.environmentFile` default | `CLOUDFLARE_API_TOKEN=…` for `cloudflare`; `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` for `route53` |
| `turn-secret` | only when `turn.enable` | coturn's static auth secret — needed only when the host has no routed IPv6 prefix |

Two inputs the module deliberately does not wire:

- **Object-storage credentials.** `kestrel-volume` reads `KESTREL_S3_ENDPOINT`, `KESTREL_S3_ACCESS_KEY_ID`,
  `KESTREL_S3_SECRET_ACCESS_KEY` (and optional `KESTREL_S3_REGION`, default `auto`) from its environment
  (packages/host/crates/volume/src/store.rs). It is spawned by `kestrel-host`, so give that unit an environment
  file (mode 0600, e.g. `/etc/kestrel-host/s3.env`):

  ```nix
  systemd.services.kestrel-host.serviceConfig.EnvironmentFile = "/etc/kestrel-host/s3.env";
  ```

- **The Nix cache signing key.** Only the public half is a module option (`nixCache.publicKey` — the host sends it
  to guests at `configure` as `nixCachePublicKey`). Keep the secret on the host
  (e.g. `/etc/kestrel-host/nix-cache-secret-key`, mode 0600): generate with
  `nix key generate-secret --key-name <slug>`, derive the public half with `nix key convert-secret-to-public`, and
  populate the served cache with `nix copy --to 'file:///var/cache/kestrel-nix?secret-key=<secretKeyFile>'`
  (nest.md, "Dependency cache").

Until step 4 the agent's control link will retry and log connect failures — expected: `/nest/hosts/connect` answers
404 while `KESTREL_NEST_DOMAIN` is unset (packages/control/src/index.ts). Verify everything else now:

- `systemctl status kestrel-host kestrel-fence kestrel-ingress kestrel-depcache caddy unbound` — all running; only
  the control link is failing.
- TLS: `journalctl -u caddy` shows the `*.<slug>.<nest-domain>` certificate issued;
  `curl -sv https://anything.<slug>.<nest-domain>/` completes a valid handshake (a 404 from `kestrel-ingress` is the
  correct answer — no box exists).
- `ls /var/cache/kestrel-nix` is populated; `ls /var/lib/kestrel-host` shows `templates/` and `vms/`.

## 4. Set `KESTREL_NEST_DOMAIN` on the Worker

`KESTREL_NEST_DOMAIN` is configuration, not a secret — it holds a public hostname (env.ts). Two ways to set it on
Worker `kestrel`:

- **Durable:** add `"KESTREL_NEST_DOMAIN": "<nest-domain>"` to `vars` in packages/control/wrangler.jsonc, next to
  `ALLOWED_GITHUB_LOGINS` (and to the `previews` vars only if Previews should also offer Nest). It takes effect on
  the next deploy of `main`, so land it as its own change *before* #349 merges.
- **Immediate, no deploy:** add it as a plain-text variable on the Worker's Settings › Variables in the Cloudflare
  dashboard. Deploys preserve vars set outside the config, but commit it to `vars` as well so the file stays the
  source of truth.

What flips the moment it is set (all already on `main`, before #349):

- `wss://<worker>/nest/hosts/connect` stops answering 404 (index.ts); the host's pending retry connects, sends
  `hello` then `capacity`, and the Hub answers `lease` (`acceptNestHost`, `onNestFrame`, hub.ts).
- `/api/nest/*` becomes reachable and `GET /api/me` reports `nestEnabled: true` — the app can then offer explicit
  Nest box creation (`POST /api/nest/boxes`, `createNestBox`). Nothing is auto-provisioned yet; `ensureNestBox`
  only exists after #349.

Verify the host is in (capacity refreshes once a minute, `NEST_CAPACITY_INTERVAL_MS`):

```sh
curl https://app.kestrel-agent.com/api/nest/hosts --cookie 'session=<operator session cookie>'
# -> { "hosts": [ { "id": "<host-id>", "name": "<slug>", "slug": "<slug>", "connected": true,
#                    "agentVersion": "…", "capacity": { "vcpus": …, "memoryBytes": …, "diskFreeBytes": …, … },
#                    "lastSeenAt": "…" } ] }
```

`connected: true` with a non-null `capacity` is the go condition. `GET /api/meter/hosts` lists the registration
row; `POST /api/meter/report` reconciles usage once VMs run.

Recommended while still on `main` — one explicit box through the whole pipeline:

```sh
curl -X POST https://app.kestrel-agent.com/api/nest/boxes --cookie 'session=…' \
  -H 'content-type: application/json' -d '{"name":"smoke"}'
# Poll GET /api/boxes until the box's nest.state is "running", then clean up:
curl -X DELETE https://app.kestrel-agent.com/api/boxes/<boxId> --cookie 'session=…'   # sends `destroy`
```

That exercises placement, `create`, template clone, enrollment, DNS and TLS end to end before users depend on it.

## 5. Merge #349

Merge only with the green check in step 4. On the first `GET /api/boxes` after the deploy, every user with zero
`user_boxes` goes through `ensureNestBox`: a box named `Kestrel` at `https://<boxId>.<slug>.<nest-domain>` with
`NEST_STANDARD_LIMITS` (4 vCPUs, 8 GiB, 64 GiB volume, no GPU), placed on the connected host with the most free
memory that still fits a 1 GiB boot plus 512 MiB headroom and 1 GiB of free disk (`placeHost`,
packages/control/src/nest-control.ts), set active, with `create` dispatched to the host. The app shows the box
`provisioning`, then `running` once the VM is configured and the box is enrolled and healthy.

If no host is connected or none has room, `ensureNestBox` fails `NoCapacity` — 503 "no Nest host has room for a new
box". `listBoxes` swallows it (the app shows no box), calls through `boxCall` return the 503, and every later request
retries placement, so restoring capacity heals by itself — but users are offline until then.

## 6. What users lose

Managed-box threads and files do not migrate: that data lives on the retired boxes' storage, and nothing in #349
copies it. A user's first post-merge `GET /api/boxes` provisions a fresh, empty Nest box. Tell users to pull out
anything they need before the merge; after it, the managed fleet is gone from the code — no `managed_boxes`, no
relay, no `box-auto` app.

## Rollback

- **Before #349 merges:** remove `KESTREL_NEST_DOMAIN`. `/nest/hosts/connect` and `/api/nest/*` go back to 404;
  nothing user-facing existed yet beyond the opt-in `POST /api/nest/boxes`.
- **After #349 merges:** removing the variable stops *new* provisioning (`ensureNestBox` returns null and
  `callTarget` answers `BoxOffline`) and closes the routes above. It does not bring managed boxes back — the code
  path no longer exists and the fleet's machines are retired. Existing Nest boxes stay in `user_boxes` and remain
  reachable on their URLs, but once the host's link drops and cannot reconnect, its lease lapses and `kestrel-fence`
  stops every running VM within one lease window (`NEST_LEASE_MS`, 5 minutes). The only other lever is redeploying a
  pre-#349 `main`, which restores the managed-box *code* against whatever state was left in the Hub's database —
  treat that as restoring code, not data.

So: after the merge the variable is an emergency brake, not a rollback. Plan the merge as one-way.
