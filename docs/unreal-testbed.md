# Unreal headless testbed

This is an opt-in experiment for a single-owner guest or isolated private lab. It does not package or download Unreal or Zen. Supply licensed binaries and an FHS-compatible runtime for your engine and Zen on NixOS; compatibility has not been established here. Use a real GPU and an explicitly chosen offscreen rendering command; do not use NullRHI. Record the machine, GPU, driver, engine build, project revision, command and configuration with each result.

## Zen service and trust boundary

Zen shared DDC is unauthenticated, uses unencrypted HTTP, and must never be public or accessible to unrelated tenants. Epic's [shared DDC setup](https://dev.epicgames.com/documentation/unreal-engine/set-up-zen-storage-server-as-shared-ddc-for-unreal-engine) documents `--config`, the Lua configuration, port, and client setup. Configure a dedicated data directory, `asio` HTTP server and a private endpoint in the operator-supplied Lua file. Confirm the exact version's configuration and bind behavior. Independently restrict the endpoint with host and network firewalls; systemd's IP filtering is defense in depth, not tenant authentication. Verify filtering works on the deployed kernel and test from both an allowed and a denied host before storing data. Do not use broad or public CIDRs. The service does not open a firewall port.

Import `nixosModules.zen-ddc` from this flake. For example, after provisioning `/srv/zen-data` writable by `kestrel-zen`, a disk/filesystem quota, executable and Lua file:

```nix
services.kestrelZenDdc = {
  enable = true;
  executable = "/opt/zen/zenserver"; # or an operator-provided FHS wrapper
  configFile = "/etc/zen/zen_config.lua";
  dataDir = "/srv/zen-data"; # must match the Lua configuration
  allowedNetworks = [ "10.42.0.0/24" ]; # only a dedicated trusted lab network
  memoryMax = "4G";
  cpuQuota = "200%";
};
```

The ACL is mandatory and applies to incoming and outgoing IP traffic; include any narrowly scoped addresses needed by your configuration. The operator is responsible for ensuring the address range is private and isolated, limiting disk consumption, protecting data at rest, and checking the service account can read the executable/config and write only the dedicated data directory. Apply the NixOS configuration, inspect `systemctl status kestrel-zen-ddc` and its journal, then check the dashboard from the trusted network. Roll back by disabling the option and switching the NixOS generation; retain or dispose of the data according to the operator's policy. Do not point this experiment at an existing shared DDC.

Strict Kestrel task network namespaces cannot reach host loopback. A host `localhost` URL therefore is not a task endpoint. A private endpoint must be reachable from the namespace and restricted to the single owner's trust boundary; do not weaken isolation or expose Zen to other tenants to make it work.

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

Run `node scripts/unreal-benchmark.mjs config.json --dry-run` to inspect the expanded argument vectors, then run it without `--dry-run`. No shell expansion occurs. Placeholders are `{engine}`, `{workspace}`, `{localCache}`, `{sharedCache}` and `{zenUrl}`. `UE_ZEN_DDC_URL` is a Kestrel hint, not a documented Unreal setting. Before any real run, select your exact engine version and follow Epic's linked instructions to configure that version's Zen shared DDC graph and namespace in the project; verify from its logs that it uses the intended URL. The runner also supplies `UE-LocalDataCachePath`, but you must verify that your selected engine version and DDC graph honor it and use different local paths. No version-specific mapping has been validated here, so a real benchmark is gated on that operator verification. It runs A cold, A warm, then B with an initially empty local cache against the intended shared service. It never resets caches or shares project Intermediate directories. A live Zen data directory may already contain metadata: use a separate empty directory as the benchmark marker and independently verify actual Zen state. The runner itself cannot attest to remote service state; record that evidence separately. Results and per-phase raw logs remain in output, including failed runs; the first failed phase stops the sequence. The JSON records durations, exits, exact argv, revision, disk sizes where `du` works, and explicitly unknown cache evidence. Inspect Unreal/Zen logs and rendered output before interpreting timings; do not invent hit rates. Record results and reevaluate before expanding the deployment.

`node scripts/unreal-benchmark-test.mjs` exercises a clearly labeled synthetic fixture only; it is not an Unreal benchmark. For the Kestrel path, the separate project-resource grant and foreground GPU-enabled `workspace_exec` changes are optional dependencies: after both land, configure an authorized owner/repository grant and use `/kestrel-project-resources/engine` (read-only), `/kestrel-project-resources/cache` (writable), `UE_ENGINE_DIR`, and `UE_ZEN_DDC_URL`. Request a GPU first, then use `workspace_exec` with `gpu: true`; no desktop is needed. Use separate threads/checkouts and separate local intermediates. Verify the endpoint is reachable under the actual sandbox policy.
