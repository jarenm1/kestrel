{ config, lib, pkgs, guest, systemDeps, sandboxEnv, sandboxSsl, ... }:

let
  volumeMount = "/var/lib/kestrel";
  # The box's user: the guest agent accepts box-socket connections only from it (NEST_BOX_USER in protocol/src/guest.ts).
  boxUser = "kestrel-box";
  boxEnvFile = "${volumeMount}/box.env";
  boxHome = "${volumeMount}/home";
  guestSocketDir = "/run/kestrel-guest";
  kestrelUid = 990;
  kestrelRuntimeDir = "/run/user/${toString kestrelUid}";

  # The image's store entries (the overlay lowerdir) and its Nix database rows, see guest.nix.
  imageStore = "/nix/.ro-store/store";
  imageRegistration = "/nix/.ro-store/registration";
  # The agent runs `systemd-random-seed save` by name; NixOS only ships it under lib/systemd.
  systemdRandomSeed = pkgs.runCommand "kestrel-systemd-random-seed" { } ''
    mkdir -p $out/bin
    ln -s ${config.systemd.package}/lib/systemd/systemd-random-seed $out/bin/systemd-random-seed
  '';

  # Started by the guest agent once it has mounted the volume at ${volumeMount}. Idempotent: on a clone or a
  # resume the store and database layers are already on the volume.
  volumeSetup = pkgs.writeShellApplication {
    name = "kestrel-volume-setup";
    runtimeInputs = with pkgs; [ coreutils util-linux gnugrep systemd nix ];
    text = ''
      vol=${volumeMount}
      mountpoint -q "$vol" || { echo "kestrel-volume-setup: $vol is not mounted" >&2; exit 1; }

      # The Nix database lives on the volume, so it belongs to this box and survives suspend. The guest agent stacks
      # the store overlay before this runs; its defaults match this image's layout.
      systemctl stop nix-daemon.service
      if [ ! -d "$vol/.nix-var" ]; then
        mkdir -p "$vol/.nix-var"
        cp -a /nix/var/. "$vol/.nix-var/"
      fi
      if ! mountpoint -q /nix/var; then
        mount --bind "$vol/.nix-var" /nix/var
      fi
      # The bind hides the boot-time database kestrel-nix-db loaded, so register the image's paths in the volume's.
      nix-store --load-db < ${imageRegistration}
      systemctl start nix-daemon.service
    '';
  };
in
{
  system.stateVersion = lib.versions.majorMinor lib.version;
  nixpkgs.config.allowUnfree = true;

  # The guest kernel is stock nixpkgs with NO_HZ_IDLE in place of NO_HZ_FULL, so an idle vCPU stops its tick
  # (docs/nest.md, "The guest image").
  boot.loader.grub.enable = false;
  boot.kernelPatches = [
    {
      name = "kestrel-nest";
      patch = null;
      structuredExtraConfig = with lib.kernel; {
        NO_HZ_FULL = lib.mkForce no;
        NO_HZ_IDLE = lib.mkForce yes;
      };
    }
  ];
  boot.kernelParams = [
    "console=hvc0"
    "memhp_default_state=online_movable"
    "zswap.enabled=1"
    "zswap.compressor=zstd"
  ];
  boot.initrd.availableKernelModules = [
    "virtio_pci"
    "virtio_blk"
    "virtio_net"
    "virtio_console"
    "virtio_mem"
    "virtio_balloon"
    "virtio_pmem"
    "libnvdimm"
    "nd_pmem"
    "erofs"
    "overlay"
    "vmw_vsock_virtio_transport"
  ];
  # `cbc` must load first: libnvdimm pulls in encrypted-keys, which needs cbc(aes) at init.
  boot.initrd.kernelModules = [ "cbc" "virtio_pmem" "nd_pmem" "erofs" "overlay" ];
  boot.kernelModules = [ "vmw_vsock_virtio_transport" "ptp_kvm" "tun" ];
  boot.blacklistedKernelModules = [ "nouveau" ];
  # NVIDIA open modules ship in the image and load on GPU hot-plug, never at boot.
  boot.extraModulePackages = [ config.boot.kernelPackages.nvidiaPackages.stable.open ];

  # Root is a tmpfs. The Nix store is the erofs image on pmem (DAX, read-only) under an overlay whose upper
  # layer is tmpfs until the guest agent moves it to the volume.
  fileSystems."/" = {
    device = "tmpfs";
    fsType = "tmpfs";
    options = [ "mode=0755" ];
    neededForBoot = true;
  };
  fileSystems."/nix/.ro-store" = {
    device = "/dev/pmem0";
    fsType = "erofs";
    options = [ "dax" "ro" ];
    neededForBoot = true;
  };
  fileSystems."/nix/.rw-store" = {
    device = "tmpfs";
    fsType = "tmpfs";
    options = [ "mode=0755" ];
    neededForBoot = true;
  };
  fileSystems."/nix/store" = {
    overlay = {
      lowerdir = [ imageStore ];
      upperdir = "/nix/.rw-store/store";
      workdir = "/nix/.rw-store/work";
    };
    neededForBoot = true;
  };

  # The volume's mount point. The guest agent mounts the volume here on `configure`.
  systemd.tmpfiles.rules = [ "d ${volumeMount} 0755 root root -" ];

  hardware.graphics.enable = true;
  hardware.graphics.extraPackages = [ config.boot.kernelPackages.nvidiaPackages.stable ];

  networking.hostName = "kestrel";
  networking.useDHCP = false;
  networking.resolvconf.enable = false;
  networking.firewall.allowedTCPPorts = [ 8787 ];

  services.chrony = {
    enable = true;
    servers = [ ];
    extraConfig = ''
      refclock PHC /dev/ptp_kvm poll 0 dpoll -2 offset 0 stratum 2 refid KVM
      makestep 1.0 3
    '';
  };
  systemd.oomd.enable = true;
  nix.settings.experimental-features = [ "nix-command" "flakes" ];

  users.groups.${boxUser} = { };
  # Lingering keeps the user manager running from boot: the box drives its per-task slices through `systemctl --user`.
  users.users.${boxUser} = {
    isSystemUser = true;
    uid = kestrelUid;
    group = boxUser;
    home = boxHome;
    createHome = false;
    linger = true;
  };

  # Root, started at boot. Owns the host link and the box socket; on `configure` it mounts the volume, sets up
  # swap, writes box.env, then starts kestrel-volume and kestrel-box.
  systemd.services.kestrel-guest-agent = {
    description = "Kestrel guest agent";
    wantedBy = [ "multi-user.target" ];
    after = [ "systemd-modules-load.service" ];
    path = with pkgs; [ coreutils util-linux e2fsprogs iproute2 kmod systemd systemdRandomSeed ];
    serviceConfig = {
      ExecStart = "${guest.agent}/bin/kestrel-guest-agent";
      Restart = "always";
      RestartSec = 1;
      RuntimeDirectory = "kestrel-guest";
      RuntimeDirectoryMode = "0755";
    };
  };

  # Loads the image's Nix database rows into the boot-time database before nix-daemon reads it. Runs on every boot
  # because the boot-time database is a tmpfs; the volume's database takes over once kestrel-volume-setup binds it.
  systemd.services.kestrel-nix-db = {
    description = "Kestrel Nix database registration";
    wantedBy = [ "nix-daemon.service" ];
    before = [ "nix-daemon.service" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "${pkgs.nix}/bin/nix-store --load-db";
      StandardInput = "file:${imageRegistration}";
    };
  };

  systemd.services.kestrel-volume = {
    description = "Kestrel volume setup (Nix store and database on the volume)";
    unitConfig.RequiresMountsFor = volumeMount;
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "${volumeSetup}/bin/kestrel-volume-setup";
    };
  };

  systemd.services.kestrel-box = {
    description = "Kestrel box";
    requires = [ "kestrel-volume.service" ];
    after = [ "kestrel-volume.service" "user@${toString kestrelUid}.service" ];
    unitConfig.ConditionPathExists = boxEnvFile;
    path = systemDeps ++ [ pkgs.nix ];
    environment = {
      XDG_RUNTIME_DIR = kestrelRuntimeDir;
      DBUS_SESSION_BUS_ADDRESS = "unix:path=${kestrelRuntimeDir}/bus";
      CLOUDAGENTS_SANDBOX_PATH = "${sandboxEnv}/bin";
      CLOUDAGENTS_SANDBOX_SSL = sandboxSsl;
      CLOUDAGENTS_TOOLKITS_FLAKE = guest.self;
      CLOUDAGENTS_GUEST_AGENT_SOCKET = "${guestSocketDir}/box.sock";
      CLOUDAGENTS_HOST = "0.0.0.0";
    };
    serviceConfig = {
      User = boxUser;
      Group = boxUser;
      EnvironmentFile = boxEnvFile;
      ExecStart = "${guest.box}/bin/kestrel-box";
      WorkingDirectory = volumeMount;
      Restart = "on-failure";
      RestartSec = 2;
    };
  };
}
