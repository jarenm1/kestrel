# Headless GPU work

Headless GPU work gives a command the host's GPU without starting a desktop. It is for offscreen rendering and compute
jobs: Unreal's `-RenderOffScreen` / Movie Render Queue, Blender's `-b`, ffmpeg's hardware encoders, CUDA or ROCm
workloads, and similar. There is no viewer, no X server, no `DISPLAY`, and no `/tmp/.X11-unix` socket.

This is different from the desktop's GPU access ([box.md](box.md#desktop)): the desktop exposes the GPU because a
sandboxed app draws on its Xwayland. A headless launch asks for the GPU directly, so it keeps working when the desktop
is stopped and never joins the desktop's X or audio sockets.

## Agent usage

`workspace_exec` takes an optional `gpu: true`:

```json
{ "command": "UnrealEditor-Cmd ... -RenderOffScreen -unattended", "gpu": true, "timeoutSec": 3600 }
```

- The command runs at the thread workspace root in the same per-thread sandbox as other agent processes, with the GPU's
  render/compute device nodes and the host's GL/Vulkan drivers. It gets no `DISPLAY`, no `PULSE_SERVER` and no X11
  socket, so the program must render offscreen.
- A GPU command is refused when no GPU is available to the run. On a box with an on-demand GPU, call `gpu_request` first
  and retry after it is attached (the request waits for the host to attach it). On a host with a static GPU, check that
  the render node exists and is readable by the box user. The error names the requirement; it never silently falls back
  to CPU rendering.
- `timeoutSec` defaults to 120 seconds. A CPU command may ask for at most 600 seconds; a GPU command may ask for at most
  21,600 seconds (6 hours). A longer CPU request is rejected rather than clamped.
- Use `gpu_release` when on-demand GPU work is finished so the host can take the GPU back. The box also withdraws the
  run's request when the run ends, including a failed or cancelled run.

The GPU command is a foreground workload. When it finishes, times out, or the run is cancelled, every process it started
is killed before the GPU lease is released. Backgrounding a child inside a GPU command does not let it outlive the call:
`nohup render >log 2>&1 &` still dies at the end of that `workspace_exec`. Start such a process outside a GPU command if
it should keep running.

## Operator configuration

The host needs a usable GPU device and its userspace drivers:

| What | Where |
|---|---|
| DRM render node | `/dev/dri/renderD*`, readable and writable by the box user. Card nodes (`/dev/dri/card*`) are never exposed because they can modeset the host display. |
| NVIDIA compute devices | `/dev/nvidiactl`, `/dev/nvidia[0-9]*`, `/dev/nvidia-uvm`, `/dev/nvidia-uvm-tools` and `/dev/nvidia-caps`, when the host uses NVIDIA's driver. `/dev/nvidia-modeset` is never exposed to headless work. |
| Driver lookup | `/sys/dev` and `/sys/devices`, bound read-only; Mesa uses them to find the render node's driver. |
| GL/Vulkan drivers | `/run/opengl-driver` and `/run/opengl-driver-32` when they exist. On NixOS this is where nixpkgs' libglvnd and Vulkan loader look. |

No environment variable turns headless GPU access on. It is available whenever the box's sandbox can expose those paths:

- `strict` and `basic` expose the device nodes and driver directories when the host has them. `strict` still sees only
  the Nix toolchain and the task's workspace; install the renderer and its drivers there.
- `off` runs without a sandbox. GPU work starts, but device isolation and the cleanup contract are weaker because there
  is no bubblewrap PID namespace.

On an on-demand GPU box (the Nest, see [nest.md](nest.md#resource-policy-host-agent)), the host lends a whole GPU while
a run holds a grant. The agent asks with `gpu_request`; the host's attach limits and billing are the same as for any
other GPU user. A box with no GPU shape reports `gpu: "none"` in `/api/capabilities` and refuses GPU commands.

GPU access is not a tenant isolation boundary. The render node, driver and GPU memory are shared with other GPU work
on the box; keep the task's CPU, RAM and storage limits, but do not treat them as a VRAM quota.

## Process cleanup contract

`workspace_exec` GPU work is supervised by `GpuCoordinator` (`packages/server/src/core/gpu-coordinator.ts`):

1. Before launching, it checks that the run may use the GPU. On an on-demand box that is the run's own standing
   `gpu_request`, once the host has attached the GPU; a device present without that grant belongs to another run and
   does not count. On a host with a static GPU it is a device present on the host. A run without a grant fails closed.
2. The launched process leads a new process group. The coordinator records that group and asks the sandbox to give the
   process only render/compute nodes and drivers.
3. On success, failure, timeout or interruption, it sends `SIGKILL` to the group, then waits (bounded, 5 seconds by
   default) for no member to remain. The lease is marked free after that wait whether or not the group is gone. If a
   member is still alive then, the coordinator logs a warning, and a later GPU job can share the device with that
   process. A process stuck in the driver can outlive `SIGKILL`.
4. Sandboxed launches run under bubblewrap with `--unshare-pid`, so the sandbox is PID 1 of its own PID namespace.
   Killing the sandbox kills everything it started, including a process that tried to detach. Under `strict`, the
   launch also joins the task's network namespace as usual; a headless GPU launch does not join the desktop's X socket
   directory.

The run's GPU request is separate from the lease: a run may execute several GPU commands under one `gpu_request`, and
the request is withdrawn at `gpu_release` or when the run ends. The coordinator only guarantees that each command's
processes are gone before its own lease is released.

## Verification and limits

Synthetic tests cover the bwrap argv (render nodes present, card nodes absent, no `DISPLAY` or X11 socket, CPU launches
unchanged) and the coordinator lifecycle (availability rejection, success, failure, cancellation and timeout cleanup).
See `packages/server/src/sandbox/gpu.test.ts` and `packages/server/src/core/headless-gpu.test.ts`.

Those tests use synthetic device lists and process groups. They do not prove that a particular driver, container image or
renderer works. Real Unreal offscreen renders, CUDA workloads, and the on-demand attach path need a test host with actual
GPU hardware and the matching userspace drivers; validate a representative job there before relying on it in
production.
