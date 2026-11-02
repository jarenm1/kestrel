#!/usr/bin/env bash
# Local, non-production experiment. Both disks must already exist and belong to this VM.
set -euo pipefail

if [[ $# != 2 ]]; then
  echo "usage: $0 OS_DISK DATA_DISK" >&2
  exit 2
fi
os_disk=$(realpath -e -- "$1")
data_disk=$(realpath -e -- "$2")
[[ -f "$os_disk" && -f "$data_disk" && "$os_disk" != "$data_disk" ]] || {
  echo 'expected two different regular disk image files' >&2; exit 1;
}
command -v qemu-system-x86_64 >/dev/null || { echo 'qemu-system-x86_64 is required' >&2; exit 1; }
command -v flock >/dev/null || { echo 'flock is required' >&2; exit 1; }
# Lock the actual files, not a name derived from their paths. QEMU receives these same open files.
exec 8<>"$os_disk" 9<>"$data_disk"
flock -n -x 8 || { echo 'OS disk is in use' >&2; exit 1; }
flock -n -x 9 || { echo 'data disk is in use' >&2; exit 1; }
# No host port forwarding, GPU, shared directories or management socket. User-mode networking
# still permits outbound traffic and access to host services: use an isolated test host.
exec qemu-system-x86_64 \
  -machine q35,accel=tcg -cpu max -smp 2 -m 2048 \
  -display none -serial mon:stdio \
  -drive "file=/proc/self/fd/8,if=virtio,format=raw" \
  -drive "file=/proc/self/fd/9,if=virtio,format=raw" \
  -nic user,model=virtio-net-pci
