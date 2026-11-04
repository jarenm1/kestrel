/**
 * Client for the Cloud Hypervisor HTTP API over a unix socket (`/api/v1/<method>`), and the VM config it boots.
 * Field names follow the Cloud Hypervisor v54 OpenAPI document.
 */

export class ChError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`cloud-hypervisor ${method} failed with ${status}: ${body.slice(0, 500)}`)
  }
}

export type MemoryRestoreMode = "Copy" | "OnDemand"

export class ChClient {
  constructor(readonly socket: string) {}

  private async call(verb: "GET" | "PUT", method: string, body?: unknown): Promise<unknown> {
    const init: RequestInit & { unix: string } = {
      method: verb,
      unix: this.socket,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }
    const response = await fetch(`http://localhost/api/v1/${method}`, init)
    const text = await response.text()
    if (!response.ok) throw new ChError(method, response.status, text)
    return text === "" ? null : JSON.parse(text)
  }

  ping(): Promise<unknown> {
    return this.call("GET", "vmm.ping")
  }

  /** Stops the VMM process itself. */
  shutdownVmm(): Promise<unknown> {
    return this.call("PUT", "vmm.shutdown")
  }

  create(config: VmConfig): Promise<unknown> {
    return this.call("PUT", "vm.create", config)
  }

  boot(): Promise<unknown> {
    return this.call("PUT", "vm.boot")
  }

  pause(): Promise<unknown> {
    return this.call("PUT", "vm.pause")
  }

  resume(): Promise<unknown> {
    return this.call("PUT", "vm.resume")
  }

  /** Powers the VM off (not the VMM). */
  shutdownVm(): Promise<unknown> {
    return this.call("PUT", "vm.shutdown")
  }

  info(): Promise<VmInfo> {
    return this.call("GET", "vm.info") as Promise<VmInfo>
  }

  /** Changes the vCPU count and/or the total memory in bytes; both are optional. */
  resize(desired: { vcpus?: number; memoryBytes?: number }): Promise<unknown> {
    return this.call("PUT", "vm.resize", {
      desired_vcpus: desired.vcpus,
      desired_ram: desired.memoryBytes,
    })
  }

  addDisk(disk: DiskConfig): Promise<unknown> {
    return this.call("PUT", "vm.add-disk", disk)
  }

  /** Hot-plugs a host PCI device (e.g. `/sys/bus/pci/devices/<addr>`, bound to vfio-pci). */
  addDevice(path: string, id: string): Promise<unknown> {
    return this.call("PUT", "vm.add-device", { path, id })
  }

  removeDevice(id: string): Promise<unknown> {
    return this.call("PUT", "vm.remove-device", { id })
  }

  /** Writes a memory image, device state and config to `dir` (created by Cloud Hypervisor if missing). */
  snapshot(dir: string): Promise<unknown> {
    return this.call("PUT", "vm.snapshot", { destination_url: `file://${dir}` })
  }

  /** Restores a snapshot directory into this (freshly started, empty) VMM; the VM stays paused. */
  restore(dir: string, mode: MemoryRestoreMode): Promise<unknown> {
    return this.call("PUT", "vm.restore", { source_url: `file://${dir}`, memory_restore_mode: mode })
  }
}

export interface VmInfo {
  readonly state: string
  readonly config: { readonly cpus?: { readonly boot_vcpus: number; readonly max_vcpus: number } }
}

export interface DiskConfig {
  readonly path: string
  readonly id: string
  readonly serial: string
  readonly readonly: boolean
  readonly direct: boolean
  readonly num_queues: number
  readonly image_type: "Raw"
}

export interface VmConfig {
  readonly payload: { readonly kernel: string; readonly cmdline: string; readonly initramfs?: string }
  readonly cpus: { readonly boot_vcpus: number; readonly max_vcpus: number }
  readonly memory: {
    readonly size: number
    readonly hotplug_size: number
    readonly hotplug_method: "VirtioMem"
    readonly shared: boolean
  }
  readonly balloon: { readonly size: number; readonly free_page_reporting: boolean }
  readonly pmem?: readonly { readonly file: string; readonly discard_writes: boolean; readonly id: string }[]
  readonly net: readonly { readonly tap: string; readonly mac: string; readonly id: string }[]
  readonly vsock: { readonly cid: number; readonly socket: string }
  readonly console: { readonly mode: "File"; readonly file: string }
  readonly serial: { readonly mode: "Off" }
}

export const TEMPLATE_BOOT_VCPUS = 1
export const TEMPLATE_BOOT_MEMORY_BYTES = 1024 * 1024 * 1024

/** The VMM config of a template: `TEMPLATE_BOOT_VCPUS` booted, `maxVcpus` allowed, memory hot-pluggable up to `maxMemoryBytes`. */
export const templateVmConfig = (opts: {
  kernel: string
  initramfs: string | null
  cmdline: string
  store: string | null
  maxVcpus: number
  maxMemoryBytes: number
  tap: string
  mac: string
  cid: number
  vsockSocket: string
  consoleFile: string
}): VmConfig => {
  const bootMemory = TEMPLATE_BOOT_MEMORY_BYTES
  return {
    payload: {
      kernel: opts.kernel,
      cmdline: opts.cmdline,
      ...(opts.initramfs === null ? {} : { initramfs: opts.initramfs }),
    },
    cpus: { boot_vcpus: TEMPLATE_BOOT_VCPUS, max_vcpus: opts.maxVcpus },
    memory: {
      size: bootMemory,
      hotplug_size: opts.maxMemoryBytes - bootMemory,
      hotplug_method: "VirtioMem",
      shared: false,
    },
    balloon: { size: 0, free_page_reporting: true },
    ...(opts.store === null ? {} : { pmem: [{ file: opts.store, discard_writes: true, id: "store" }] }),
    net: [{ tap: opts.tap, mac: opts.mac, id: "net0" }],
    vsock: { cid: opts.cid, socket: opts.vsockSocket },
    console: { mode: "File", file: opts.consoleFile },
    serial: { mode: "Off" },
  }
}
