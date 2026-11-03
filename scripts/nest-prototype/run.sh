#!/usr/bin/env bash
# Local, non-production experiment. Both disks must already exist and belong to this VM.
#
# Optional environment:
#   KESTREL_VM_NAME           QEMU name and process name (default kestrel-vm-manual)
#   KESTREL_VM_CPUS           vCPUs, 1-8 (default 2)
#   KESTREL_VM_MEMORY_MB      guest RAM in MiB, 1-4096 (default 2048)
#   KESTREL_VM_ACCEL          auto|kvm|tcg (default auto: kvm when /dev/kvm is usable)
#   KESTREL_VM_CONSOLE_SOCKET unix socket serving the serial console (default: this terminal)
#   KESTREL_VM_CONSOLE_LOG    file receiving a copy of the serial console (socket mode only)
#   KESTREL_VM_QMP_SOCKET     unix socket serving QMP for lifecycle control
set -euo pipefail

if [[ $# != 2 ]]; then
  echo "usage: $0 OS_DISK DATA_DISK" >&2
  exit 2
fi
os_disk=$(realpath -e -- "$1")
data_disk=$(realpath -e -- "$2")
[[ -f "$os_disk" && -f "$data_disk" && ! "$os_disk" -ef "$data_disk" ]] || {
  echo 'expected two different regular disk image files' >&2; exit 1;
}
command -v qemu-system-x86_64 >/dev/null || { echo 'qemu-system-x86_64 is required' >&2; exit 1; }
command -v flock >/dev/null || { echo 'flock is required' >&2; exit 1; }

name=${KESTREL_VM_NAME:-kestrel-vm-manual}
[[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || { echo 'KESTREL_VM_NAME must match [A-Za-z0-9._-]+' >&2; exit 2; }
cpus=${KESTREL_VM_CPUS:-2}
[[ "$cpus" =~ ^[1-9][0-9]*$ ]] && (( cpus <= 8 )) || { echo 'KESTREL_VM_CPUS must be 1-8' >&2; exit 2; }
memory_mb=${KESTREL_VM_MEMORY_MB:-2048}
[[ "$memory_mb" =~ ^[1-9][0-9]*$ ]] && (( memory_mb <= 4096 )) || { echo 'KESTREL_VM_MEMORY_MB must be 1-4096' >&2; exit 2; }

accel=${KESTREL_VM_ACCEL:-auto}
if [[ "$accel" == auto ]]; then
  if [[ -r /dev/kvm && -w /dev/kvm ]]; then accel=kvm; else accel=tcg; fi
fi
case "$accel" in
  kvm) machine_accel='accel=kvm'; cpu_model=host ;;
  tcg) machine_accel='accel=tcg'; cpu_model=max ;;
  *) echo 'KESTREL_VM_ACCEL must be auto, kvm or tcg' >&2; exit 2 ;;
esac

console_args=(-display none -serial mon:stdio)
if [[ -n "${KESTREL_VM_CONSOLE_SOCKET:-}" ]]; then
  # QEMU option strings split on commas; a literal comma in a path is written as ",,".
  console_socket=${KESTREL_VM_CONSOLE_SOCKET//,/,,}
  chardev="socket,id=console,path=$console_socket,server=on,wait=off"
  if [[ -n "${KESTREL_VM_CONSOLE_LOG:-}" ]]; then
    console_log=${KESTREL_VM_CONSOLE_LOG//,/,,}
    chardev+=",logfile=$console_log"
  fi
  console_args=(-display none -chardev "$chardev" -serial chardev:console)
fi
qmp_args=()
if [[ -n "${KESTREL_VM_QMP_SOCKET:-}" ]]; then
  qmp_socket=${KESTREL_VM_QMP_SOCKET//,/,,}
  qmp_args=(-qmp "unix:$qmp_socket,server=on,wait=off")
fi

# Lock the actual files, not a name derived from their paths. QEMU receives these same open files.
exec 8<>"$os_disk" 9<>"$data_disk"
flock -n -x 8 || { echo 'OS disk is in use' >&2; exit 1; }
flock -n -x 9 || { echo 'data disk is in use' >&2; exit 1; }
# No host port forwarding, GPU, shared directories or management socket beyond the explicit
# QMP/console sockets above. User-mode networking still permits outbound traffic and access
# to host services: use an isolated test host.
exec qemu-system-x86_64 \
  -name "$name,process=$name" \
  -machine "q35,$machine_accel" -cpu "$cpu_model" -smp "$cpus" -m "$memory_mb" \
  -no-reboot \
  "${console_args[@]}" \
  "${qmp_args[@]}" \
  -drive "file=/proc/self/fd/8,if=virtio,format=raw" \
  -drive "file=/proc/self/fd/9,if=virtio,format=raw" \
  -object rng-random,filename=/dev/urandom,id=rng0 -device virtio-rng-pci,rng=rng0 \
  -nic user,model=virtio-net-pci
