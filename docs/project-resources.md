# Project resources

An operator can provision a versioned engine directory and a shared project cache on a box. This is opt-in: set `CLOUDAGENTS_PROJECT_RESOURCES_FILE` to an absolute canonical path to a host-controlled JSON file before starting the box. The manifest must be a regular file without symlink components, outside the box data directory and every writable resource cache. Sandboxing must be enabled. The box validates the file at startup and rejects invalid configuration. These path checks do not replace the requirement for host-controlled ancestors: operators must prevent sandbox users from modifying or replacing the manifest and its parent directories.

```json
{
  "version": 1,
  "grants": [{
    "owner": "alice",
    "repo": "org/game",
    "trustGroup": "game-team",
    "engineDir": "/srv/kestrel-engines/ue-5.5",
    "cacheDir": "/srv/kestrel-caches/game",
    "zenDdcUrl": "http://zen.example:8558"
  }]
}
```

`owner` is the exact Kestrel login, and `repo` is the canonical GitHub `owner/name` stored on a checkout. A grant applies only when both match the thread and one of its checkouts. A thread matching multiple grants cannot launch until the ambiguity is removed. The manifest, directories, and their ancestors must be controlled by the box operator, not writable or replaceable by sandbox users. Use existing absolute canonical directories, without symlink components, outside the box data directory and system directories. The box checks them at startup and again on launch; this assumes the operator keeps their ancestors protected against replacement between checks and mounts.

The engine appears read-only at `/kestrel-project-resources/engine`, also named by `UE_ENGINE_DIR`. The cache is writable at `/kestrel-project-resources/cache`. Configure Unreal to use that cache explicitly; project intermediates stay in each checkout. `zenDdcUrl` is optional and passed as `UE_ZEN_DDC_URL`; it must be a nonsecret HTTP(S) URL without credentials, query or fragment. Kestrel does not run Zen or download an engine. Supply writable scratch separately within the thread workspace or home when an engine operation requires writes.

Overlapping engine and cache paths are rejected. A cache may be shared by grants only when the paths are identical and their `trustGroup` values match: everyone in that group can read and modify the same cache. Provision distinct caches for mutually untrusted projects. Engine directories may be shared read-only. Never put secrets in the manifest or either directory.

Resources are selected for each new harness, workspace command, desktop application, and desktop terminal launch. A checkout made during an existing run does not change that run's mounts; the next launch sees it. Already running desktop processes retain their original mounts. Restart the box to load manifest changes.

Shared resource storage is outside thread storage accounting and is not deleted when a thread is removed. The operator must monitor capacity and manage retention and cleanup; Kestrel does not enforce a filesystem quota for it. Coordinate cleanup with running processes and protect provisioned directories from modification by untrusted host users.
