# Unreal headless testbed

This is an opt-in experiment for a single-owner guest or isolated private lab. It does not package or download Unreal or Zen. Supply licensed binaries and an FHS-compatible runtime for your engine and Zen on NixOS; compatibility has not been established here. Use a real GPU and an explicitly chosen offscreen rendering command; do not use NullRHI. Record the machine, GPU, driver, engine build, project revision, command and configuration with each result.

## Zen service and trust boundary

Zen shared DDC is unauthenticated, uses unencrypted HTTP, and must never be public or accessible to unrelated tenants. Epic's [shared DDC setup](https://dev.epicgames.com/documentation/unreal-engine/set-up-zen-storage-server-as-shared-ddc-for-unreal-engine) documents `--config`, the Lua configuration, port, and client setup. Epic considers only the Windows Zen server production-ready for shared DDC as of UE 5.5; treat the Linux service below as a lab experiment. Confirm the exact version's configuration and bind behavior. Independently restrict the endpoint with host and network firewalls; systemd's IP filtering is defense in depth, not tenant authentication. Verify filtering works on the deployed kernel and test from both an allowed and a denied host before storing data. Do not use broad or public CIDRs. The service does not open a firewall port.

Start from Epic's `zen_config.lua` template and adapt it for the Linux `asio` HTTP server. This example uses a dedicated data directory, the default private port, and a 1 GiB in-memory layer:

```lua
-- /etc/zen/zen_config.lua -- operator-supplied, adapted from Epic's Zen config template.
server = {
    dedicated = true,
    datadir = "/srv/zen-data",       -- must match services.kestrelZenDdc.dataDir
    abslog = "/srv/zen-data/zen.log",
    debug = false,
    sentry = {
        disable = true,              -- do not send crash data to Epic
        allowpersonalinfo = false,
    },
}

network = {
    httpserverclass = "asio",        -- httpsys is the Windows class; use asio on Linux
    port = 8558,                     -- private endpoint; keep it behind the lab firewall
}

gc = {
    intervalseconds = 28800,         -- every 8 hours
    lightweightintervalseconds = 3600,
    cache = { maxdurationseconds = 864000 },
}

cache = {
    enable = true,
    accesslog = false,
    upstream = {
        upstreamthreadcount = 4,
        policy = "disabled",         -- no upstream cache in this isolated testbed
    },
    memlayer = {
        targetfootprint = 1073741824, -- 1 GiB; leave headroom under MemoryMax
        triminterval = 120,
        maxage = 172800,
    },
}
```

The documented template configures a port but not a bind address. Keep the host on a dedicated private network, verify what the process actually listens on with `ss -ltnp`, and restrict it with the host firewall. `systemd`'s `IPAddressAllow` is defense in depth; it is not authentication.

Import `nixosModules.zen-ddc` from this flake. For example, after provisioning `/srv/zen-data` writable by `kestrel-zen`, a disk/filesystem quota, executable and Lua file:

```nix
services.kestrelZenDdc = {
  enable = true;
  executable = "/opt/zen/zenserver"; # or an operator-provided FHS wrapper
  configFile = "/etc/zen/zen_config.lua";
  dataDir = "/srv/zen-data"; # must match server.datadir in the Lua file
  allowedNetworks = [ "10.42.0.0/24" ]; # only a dedicated trusted lab network
  memoryMax = "4G"; # keep above cache.memlayer.targetfootprint
  cpuQuota = "200%";
};
```

The module asserts that the ACL is non-empty, that all paths are absolute, that `dataDir` is not `/` or under `/etc`, and that the ACL contains no empty entry, `0.0.0.0/0` or `::/0`. The ACL applies to incoming and outgoing IP traffic; include any narrowly scoped addresses needed by your configuration. The operator is responsible for ensuring the address range is private and isolated, limiting disk consumption, protecting data at rest, and checking the service account can read the executable/config and write only the dedicated data directory. Apply the NixOS configuration, inspect `systemctl status kestrel-zen-ddc` and its journal, then check the dashboard from the trusted network. Roll back by disabling the option and switching the NixOS generation; retain or dispose of the data according to the operator's policy. Do not point this experiment at an existing shared DDC.

Strict Kestrel task network namespaces cannot reach host loopback. A host `localhost` URL therefore is not a task endpoint. A private endpoint must be reachable from the namespace and restricted to the single owner's trust boundary; do not weaken isolation or expose Zen to other tenants to make it work.

## Unreal Engine client configuration

Epic configures the Zen-shared layer through `[StorageServers]` and the `[DerivedDataBackendGraph]` section of the project's `DefaultEngine.ini`. Unreal's stock `BaseEngine.ini` defines a `ZenShared` graph node that redirects to the `Shared` server entry with `ServerID=Shared`; copy the exact lines from the engine version you use rather than assuming this layout. A project override for a private endpoint looks like:

```ini
; Config/DefaultEngine.ini
[StorageServers]
Shared=(Host="http://10.42.0.10:8558", Namespace="myproject.ddc", EnvHostOverride=UE-ZenSharedDataCacheHost, CommandLineHostOverride=ZenSharedDataCacheHost, DeactivateAt=60)

[DerivedDataBackendGraph]
; Optional: drop a legacy fileshare layer if the stock graph still contains Inner=Shared.
Root=(Type=Hierarchical, Inner=Pak, Inner=EnginePak, Inner=ZenLocal, Inner=Local, Inner=ZenShared, Inner=Cloud)
```

The namespace must be 64 characters or fewer, must not start or end with a period, and may contain only lowercase letters, digits, `-`, `_` and `.`. Use a distinct namespace for the benchmark so its data is semi-distinct from other projects on the same instance. Confirm the connection in the Unreal log:

```
LogDerivedDataCache: Display: ZenShared: Using ZenServer HTTP service at http://10.42.0.10:8558/ with namespace myproject.ddc status: OK!.
```

Epic documents environment overrides as well. Dashed names cannot be exported by `bash` directly, so pass them through `env`:

```sh
env \
  'UE-ZenSharedDataCacheHost=10.42.0.10' \
  'UE-LocalDataCachePath=/lab/cache-a' \
  '/lab/engine/Engine/Binaries/Linux/UnrealEditor-Cmd' \
  '/lab/a/Project.uproject' \
  YOUR_OFFSCREEN_RENDER_ARGUMENTS
```

- `UE-ZenSharedDataCacheHost` overrides the shared Zen host for the stock `Shared` entry. Epic documents a host name or IP, with the default 8558 port implied; if your engine version expects a port or scheme here, verify it from the log line. On macOS Epic documents `UE_ZenSharedDataCacheHost` instead.
- `UE-LocalDataCachePath` overrides the local DDC path; this is the documented way to keep the two workspaces' local caches separate.
- `UE-SharedDataCachePath` is for Filesystem shared DDCs; setting it to `None` disables that layer. It does not point a Zen layer at a URL.

The benchmark runner exports `UE-LocalDataCachePath=<phase cache>` and `UE_ZEN_DDC_URL=<zenUrl>`. Only the first is a documented Unreal setting; `UE_ZEN_DDC_URL` is a Kestrel hint that stock Unreal ignores. The runner does not set `UE-ZenSharedDataCacheHost`, so configure the host in `DefaultEngine.ini` or set that variable in the environment the runner inherits. Always verify from the engine log that it used the intended endpoint and namespace.

## Benchmark

Prepare two distinct clean disposable project checkouts at the same commit, an engine directory, separate empty local cache directories, a new empty **disposable** shared cache/data directory, and an empty output directory. All seven paths must be disjoint. Configure a new Zen instance to use that shared directory; never clear or repurpose an existing shared DDC. Ensure the project and Unreal configuration actually direct DDC traffic to that endpoint. Engine and project versions, DDC graph and project-specific render command are operator choices. Use a foreground, terminating offscreen render that produces an image or other independently verifiable rendering evidence. The runner does not verify rendering, enforce Unreal's cache configuration, or prove that a shared cache was hit.

Create a JSON config (replace every path and the illustrative command with your own verified executable and arguments):

```json
{
  "version": 1, "disposable": true, "synthetic": false,
  "engineIdentity": "operator-recorded engine version and build hash",
  "engine": "/lab/engine", "workspaceA": "/lab/a", "workspaceB": "/lab/b",
  "localCacheA": "/lab/cache-a", "localCacheB": "/lab/cache-b",
  "sharedCache": "/lab/zen-data", "output": "/lab/results",
  "zenUrl": "http://10.42.0.10:8558", "timeoutSeconds": 1800,
  "argv": ["{engine}/Engine/Binaries/Linux/UnrealEditor-Cmd", "{workspace}/Project.uproject", "YOUR_OFFSCREEN_RENDER_ARGUMENTS"]
}
```

Run `node scripts/unreal-benchmark.mjs config.json --dry-run` to inspect the expanded argument vectors, then run it without `--dry-run`. No shell expansion occurs. Placeholders are `{engine}`, `{workspace}`, `{localCache}`, `{sharedCache}` and `{zenUrl}`. Before any real run, select your exact engine version and follow Epic's linked instructions to configure that version's Zen shared DDC graph and namespace in the project; verify from its logs that it uses the intended URL. The runner also supplies `UE-LocalDataCachePath`, but you must verify that your selected engine version and DDC graph honor it and use different local paths. No version-specific mapping has been validated here, so a real benchmark is gated on that operator verification.

The runner refuses to start unless all paths resolve and are disjoint, both workspaces are clean Git checkouts at the same revision, the cache and output directories are empty, `argv` does not mention NullRHI, and `timeoutSeconds` is positive. It runs A cold, A warm, then B with an initially empty local cache against the intended shared service. It never resets caches or shares project Intermediate directories. A live Zen data directory may already contain metadata: use a separate empty directory as the benchmark marker and independently verify actual Zen state.

**Interrupts and failures.** `SIGINT`/`SIGTERM` kills the active process group, writes a result with `interrupted: true` and `interruptSignal`, and skips every later phase even if the child had already exited with code 0. A child launch error does the same. Signal listeners are removed in a `finally` block, so embedding the runner or running several fixtures does not accumulate handlers. Each phase has its own timeout: an expired timeout kills the process group, records `timedOut: true`, and stops the sequence at that phase. The phase log descriptor is closed when the phase ends, including after a timeout or interrupt.

**Disk size versus cold-cache evidence.** The result keeps these separate. `diskMeasurement` and each run's `diskBytes` report `du` sizes for the local cache and shared directory after the phase: this is measured storage on the host, not evidence about the remote Zen service or about cache hits. `coldCache` is always marked `operator-attested` (or `not-run` for a dry run) with a note, and every run has `remoteCacheState: "unverified"` plus a `cacheAssumption`. The runner cannot inspect or reset the remote service, so the operator must independently attest that the service was cold before the `a-cold` phase and record that evidence separately. The same warning is written at the top of each phase log. Inspect Unreal/Zen logs and rendered output before interpreting timings; do not invent hit rates.

`node scripts/unreal-benchmark-test.mjs` exercises a clearly labeled synthetic fixture only; it is not an Unreal benchmark. Besides the happy path and dry run, it covers the guard rails: overlapping paths, a dirty workspace, NullRHI in `argv`, timeout termination, and `SIGINT` stopping the sequence after the first phase.

## Standalone host runner versus two Kestrel threads

These are different arrangements, and neither one proves a cache hit.

| | Standalone host runner | Two Kestrel threads |
|---|---|---|
| Sequencing | One process runs A cold, A warm, B and owns timeouts and logs | Each thread runs its own command; you sequence cold/warm phases and interpret separate logs |
| Paths | Host paths validated with `realpath`, disjoint and clean Git required | Each thread has its own checkout and sandbox-local paths; separate local intermediates |
| Network | Direct private host/LAN access to Zen | Each sandbox namespace must reach the private endpoint; host loopback is unreachable |
| GPU | Operator prepares the engine and GPU; runner does not provision either | Request a GPU, then run `workspace_exec` with `gpu: true` |
| Shared cache | Configured by the operator; runner measures local disk only | Requires the project-resource grant, typically `/kestrel-project-resources/cache`; runner does not orchestrate it |
| Evidence | One `result.json` plus per-phase logs and rendered output | Thread transcripts and logs; no combined result from the two threads |

For the Kestrel path, the separate project-resource grant and foreground GPU-enabled `workspace_exec` changes are optional dependencies: after both land, configure an authorized owner/repository grant and use `/kestrel-project-resources/engine` (read-only), `/kestrel-project-resources/cache` (writable), `UE_ENGINE_DIR`, and the host/namespace configuration above. Request a GPU first, then use `workspace_exec` with `gpu: true`; no desktop is needed. Use separate threads/checkouts and separate local intermediates. Verify the endpoint is reachable under the actual sandbox policy.

Two threads also have no shared clock or guaranteed ordering: running them concurrently makes the "cold" and "warm" labels meaningless, and a disk measurement inside one sandbox says nothing about the other or about Zen. If you need comparable phases, use the standalone runner, or drive the phases from one thread while the other only consumes the cache after the sequence is finished.
