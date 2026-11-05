{ self }:

{ config, lib, pkgs, ... }:

let
  cfg = config.services.kestrel-nest;
  system = pkgs.stdenv.hostPlatform.system;
  packages = self.packages.${system};

  stateDir = "/var/lib/kestrel-host";
  secretsDir = "/etc/kestrel-host";
  configFile = "${secretsDir}/config.json";
  runDir = "/run/kestrel-host";
  apiSocket = "${runDir}/api.sock";
  depcacheListen = "169.254.0.1:3141";
  nixCacheListen = "169.254.0.1:5000";
  ingressListen = "127.0.0.1:8081";
  hostAddress = "169.254.0.1";

  # Caddy DNS-01 plugins, built into the Caddy package. `tls` is the Caddyfile `dns` directive's arguments.
  acmeDnsPlugins = {
    cloudflare = {
      plugin = "github.com/caddy-dns/cloudflare@v0.2.3";
      hash = "sha256-weP1HzwGvPlLqiAViJus1GN74bps3bI179gomTCb6N4=";
      tls = "cloudflare {env.CLOUDFLARE_API_TOKEN}";
    };
    route53 = {
      plugin = "github.com/caddy-dns/route53@v1.6.2";
      hash = "sha256-/G82qaQUcNaCSmSHWnyOIYbK+K6oHHUHWEpR+4lke54=";
      tls = "route53";
    };
  };
  acmeDns = acmeDnsPlugins.${cfg.acme.dnsProvider};

  # Sandboxing shared by the host services that take guest or internet input.
  hardened = {
    NoNewPrivileges = true;
    ProtectSystem = "strict";
    ProtectHome = true;
    PrivateTmp = true;
    PrivateDevices = true;
    ProtectKernelTunables = true;
    ProtectKernelModules = true;
    ProtectKernelLogs = true;
    ProtectControlGroups = true;
    ProtectClock = true;
    ProtectHostname = true;
    RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
    RestrictNamespaces = true;
    RestrictRealtime = true;
    RestrictSUIDSGID = true;
    LockPersonality = true;
    MemoryDenyWriteExecute = true;
    CapabilityBoundingSet = [ "" ];
    SystemCallArchitectures = "native";
    SystemCallFilter = [ "@system-service" "~@privileged @resources" ];
    UMask = "0077";
  };

  gpuVendorDevice = lib.concatStringsSep "," cfg.gpu.vendorDevices;

  iommuParams =
    if cfg.cpuVendor == "intel" then [ "intel_iommu=on" ] else [ "amd_iommu=on" "iommu=pt" ];

  # `/etc/kestrel-host/config.json`, the file `kestrel-host daemon` reads (src/config.ts `HostConfig`).
  hostConfig = {
    inherit (cfg) hostId slug controlUrl hostSecretFile meterUrl template capacity gpus egressMbit
      idleSuspendAfterMs parkAfterMs backupIntervalMs meterIntervalMs volumeStore volumeKeyFile;
    stateDir = stateDir;
    runDir = runDir;
    nestDomain = cfg.domain;
    agentVersion = self.shortRev or self.dirtyShortRev or "unknown";
    cloudHypervisor = "${pkgs.cloud-hypervisor}/bin/cloud-hypervisor";
    volumeTool = "${packages."kestrel-volume"}/bin/kestrel-volume";
    guestImageDir = "${cfg.guestImage}";
    scope = "systemd-system";
    depcacheUrl = "http://${depcacheListen}";
    nixCacheUrl = "http://${nixCacheListen}";
    nixCachePublicKey = cfg.nixCache.publicKey;
  };
in
{
  options.services.kestrel-nest = {
    enable = lib.mkEnableOption "the Nest host (per-user VMs on Cloud Hypervisor)";

    slug = lib.mkOption {
      type = lib.types.strMatching "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
      description = "This host's DNS label; boxes are served at `<boxId>.<slug>.<domain>`.";
    };

    hostId = lib.mkOption {
      type = lib.types.str;
      default = cfg.slug;
      defaultText = lib.literalExpression "config.services.kestrel-nest.slug";
      description = "This host's id at the control plane (`hostId`).";
    };

    domain = lib.mkOption {
      type = lib.types.str;
      description = "The Nest domain (`nestDomain`). Caddy serves `*.<slug>.<domain>`.";
    };

    controlUrl = lib.mkOption {
      type = lib.types.str;
      description = "Base URL of the control plane the host agent connects to (`ws://` or `wss://`).";
    };

    meterUrl = lib.mkOption {
      type = lib.types.str;
      description = "Control plane origin for meter batches (`https://`).";
    };

    hostSecretFile = lib.mkOption {
      type = lib.types.str;
      default = "${secretsDir}/host-secret";
      description = "File holding the host secret the control plane issued to this host.";
    };

    uplink = lib.mkOption {
      type = lib.types.str;
      description = "Network interface guests reach the internet through (masqueraded).";
    };

    cpuVendor = lib.mkOption {
      type = lib.types.enum [ "intel" "amd" ];
      description = "Selects the IOMMU kernel parameters for GPU passthrough.";
    };

    capacity = {
      vcpus = lib.mkOption {
        type = lib.types.ints.positive;
        description = "Logical CPUs the host gives to VMs.";
      };
      memoryBytes = lib.mkOption {
        type = lib.types.ints.positive;
        description = "Memory the host gives to VMs, in bytes.";
      };
    };

    template = {
      maxVcpus = lib.mkOption {
        type = lib.types.ints.positive;
        description = "Largest vCPU count a box may be given on this host.";
      };
      maxMemoryBytes = lib.mkOption {
        type = lib.types.ints.positive;
        description = "Largest memory a box may be given on this host, in bytes (above the 1 GiB template boot memory).";
      };
    };

    gpus = lib.mkOption {
      type = lib.types.listOf (lib.types.submodule {
        options = {
          pciAddress = lib.mkOption { type = lib.types.str; example = "0000:01:00.0"; };
          model = lib.mkOption { type = lib.types.str; example = "NVIDIA RTX A4000"; };
          vramBytes = lib.mkOption { type = lib.types.ints.unsigned; };
        };
      });
      default = [ ];
      description = "GPUs the host can attach on demand (`pciAddress` is the function bound to vfio-pci).";
    };

    egressMbit = lib.mkOption {
      type = lib.types.ints.positive;
      default = 200;
      description = "Per-VM egress limit in Mbit/s (`tc`).";
    };

    idleSuspendAfterMs = lib.mkOption {
      type = lib.types.ints.positive;
      default = 10 * 60 * 1000;
      description = "A running box idle this long is suspended.";
    };

    parkAfterMs = lib.mkOption {
      type = lib.types.ints.positive;
      default = 7 * 24 * 60 * 60 * 1000;
      description = "A suspended box this long is parked.";
    };

    backupIntervalMs = lib.mkOption {
      type = lib.types.ints.positive;
      default = 60 * 60 * 1000;
      description = "How often a running box's volume is backed up.";
    };

    meterIntervalMs = lib.mkOption {
      type = lib.types.ints.positive;
      default = 60 * 1000;
      description = "How often meter batches are shipped to the control plane.";
    };

    volumeStore = lib.mkOption {
      type = lib.types.str;
      description = "Backing store for volumes and backups: `file:///dir` or `s3://bucket/prefix`.";
    };

    volumeKeyFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = "${secretsDir}/volume.key";
      description = "Fleet key for `kestrel-volume --key-file`; null when the store is unencrypted.";
    };

    guestImage = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${system}.nest-guest;
      defaultText = lib.literalExpression "self.packages.\${system}.nest-guest";
      description = "The guest image (`manifest.json`, kernel, initrd, store, cmdline) new VMs are cloned from.";
    };

    acme = {
      dnsProvider = lib.mkOption {
        type = lib.types.enum (builtins.attrNames acmeDnsPlugins);
        description = "DNS provider for the wildcard certificate (Caddy DNS-01). Its credentials come from `acme.environmentFile`.";
      };
      environmentFile = lib.mkOption {
        type = lib.types.str;
        default = "${secretsDir}/caddy.env";
        description = "EnvironmentFile for Caddy with the DNS provider's credentials: CLOUDFLARE_API_TOKEN for cloudflare; AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_REGION for route53.";
      };
    };

    nixCache = {
      publicKey = lib.mkOption {
        type = lib.types.str;
        example = "nest-host-1:0123abcd...=";
        description = "Public key (`name:base64`) of this host's signed Nix cache. The host agent sends it to guests at `configure`, and guests trust it.";
      };
    };

    gpu.vendorDevices = lib.mkOption {
      type = lib.types.listOf (lib.types.strMatching "[0-9a-f]{4}:[0-9a-f]{4}");
      default = [ ];
      example = [ "10de:2684" ];
      description = "vendor:device IDs of GPUs bound to vfio-pci at boot (for on-demand attach).";
    };

    turn.enable = lib.mkEnableOption "coturn on the host for WebRTC (used when no routed IPv6 prefix is available)";
  };

  config = lib.mkIf cfg.enable {
    boot.kernelParams = iommuParams ++ [
      "transparent_hugepage=madvise"
    ] ++ lib.optional (cfg.gpu.vendorDevices != [ ]) "vfio-pci.ids=${gpuVendorDevice}";

    boot.kernelModules = [ "kvm" "vfio-pci" "ublk_drv" "vhost_vsock" "vhost_net" "tun" ];
    boot.kernel.sysctl."net.ipv4.ip_forward" = 1;
    boot.blacklistedKernelModules = [ "nouveau" ];

    environment.systemPackages = [
      pkgs.cloud-hypervisor
      pkgs.xfsprogs
      pkgs.nftables
      pkgs.iproute2
      packages."kestrel-host"
      packages."kestrel-volume"
    ];

    users.groups.kestrel-ingress = { };
    users.users.kestrel-ingress = {
      isSystemUser = true;
      group = "kestrel-ingress";
    };
    users.groups.kestrel-depcache = { };
    users.users.kestrel-depcache = {
      isSystemUser = true;
      group = "kestrel-depcache";
      home = "/var/cache/kestrel-depcache";
    };

    environment.etc."kestrel-host/config.json".source =
      pkgs.writeText "kestrel-host-config.json" (builtins.toJSON hostConfig);

    systemd.tmpfiles.rules = [
      "d ${stateDir} 0700 root root -"
      "d ${stateDir}/templates 0700 root root -"
      "d ${stateDir}/vms 0700 root root -"
      "d ${secretsDir} 0700 root root -"
      "d /var/cache/kestrel-depcache 0750 kestrel-depcache kestrel-depcache -"
      "d /var/cache/kestrel-nix 0755 root root -"
    ];

    systemd.slices."kestrel-vms" = {
      description = "Nest VMs (one scope per box; the cgroup is the meter)";
      sliceConfig.MemoryAccounting = true;
    };

    # The host's /169.254.0.1 address, where guests reach the dependency cache, the Nix cache and DNS.
    networking.useNetworkd = true;
    systemd.network.netdevs."10-kestrel0" = {
      netdevConfig = {
        Kind = "dummy";
        Name = "kestrel0";
      };
    };
    systemd.network.networks."10-kestrel0" = {
      matchConfig.Name = "kestrel0";
      address = [ "${hostAddress}/32" ];
    };
    # The kestrel table is this host's firewall (docs/nest.md). NixOS's nixos-fw input chain has policy drop and
    # would drop the guests' dependency-cache, Nix-cache and DNS connections before the kestrel accepts run.
    networking.firewall.enable = false;
    networking.nftables.enable = true;
    networking.nftables.ruleset = ''
      table inet kestrel {
        # Anti-spoof: a guest's tap may send only from the address the host agent assigned to it. The agent
        # fills this set when it creates the tap: `nft add element inet kestrel tap_addrs { "kn-<id>" . <vm-ip> }`.
        set tap_addrs {
          type ifname . ipv4_addr;
        }
        chain tap_source {
          iifname . ip saddr != @tap_addrs drop
        }
        chain forward {
          type filter hook forward priority filter; policy drop;
          iifname "kn-*" jump tap_source
          ct state established,related accept
          # Guests reach the internet only through the uplink, never private, link-local, CGNAT or loopback ranges.
          iifname "kn-*" oifname "${cfg.uplink}" ip daddr != { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10, 127.0.0.0/8 } accept
        }
        chain input {
          type filter hook input priority filter; policy drop;
          iifname "lo" accept
          iifname "kn-*" jump tap_source
          ct state established,related accept
          # Guests reach the dependency cache, the Nix cache and DNS on the host's /32, nothing else on the host.
          iifname "kn-*" ip daddr ${hostAddress} tcp dport { 53, 3141, 5000 } accept
          iifname "kn-*" ip daddr ${hostAddress} udp dport 53 accept
          iifname "kn-*" drop
          # Everything below is the host's own surface, reached only from outside the taps.
          tcp dport { 22, 80, 443 } accept
          icmp type echo-request accept
          # IPv6 neighbour discovery and router advertisements, and DHCP replies on the uplink.
          meta l4proto ipv6-icmp accept
          udp dport { 68, 546 } accept
${lib.optionalString cfg.turn.enable "          udp dport ${toString config.services.coturn.listening-port} accept\n          tcp dport ${toString config.services.coturn.listening-port} accept\n          udp dport ${toString config.services.coturn.min-port}-${toString config.services.coturn.max-port} accept\n"}
        }
        chain output {
          type filter hook output priority filter; policy accept;
          ${lib.optionalString cfg.turn.enable "          # coturn must not relay to the host's own addresses (the fib match covers every local address).\n          meta skuid ${toString config.users.users.turnserver.uid} fib daddr type local drop\n"}
        }
      }
      table ip kestrel-nat {
        chain postrouting {
          type nat hook postrouting priority srcnat; policy accept;
          iifname "kn-*" oifname "${cfg.uplink}" masquerade
        }
      }
    '';

    # Guests resolve names through this resolver on the host's /32. The host keeps its own resolver settings.
    services.unbound = {
      enable = true;
      resolveLocalQueries = false;
      settings.server = {
        interface = [ hostAddress ];
        port = 53;
        access-control = [ "10.77.0.0/16 allow" "0.0.0.0/0 refuse" ];
        hide-identity = true;
        hide-version = true;
      };
    };
    systemd.services.unbound = {
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      serviceConfig = {
        Restart = lib.mkForce "always";
        RestartSec = lib.mkForce 2;
      };
    };

    systemd.services.kestrel-host = {
      description = "Nest host agent";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" "kestrel-depcache.service" "kestrel-nix-cache.service" ];
      wants = [ "network-online.target" ];
      # The daemon shells out to `ip`, `tc`, `nft`, `systemd-run`, `cp` and the volume tool.
      path = with pkgs; [ cloud-hypervisor iproute2 nftables xfsprogs systemd coreutils packages."kestrel-volume" ];
      serviceConfig = {
        ExecStart = "${packages."kestrel-host"}/bin/kestrel-host daemon --config ${configFile}";
        Restart = "always";
        RestartSec = 2;
        RuntimeDirectory = "kestrel-host";
        RuntimeDirectoryMode = "0750";
        # The API socket is shared with kestrel-ingress through this group: the directory is 0750 and the
        # agent creates the socket 0660 in it.
        Group = "kestrel-ingress";
        LimitNOFILE = 1048576;
        KillMode = "process";
      };
    };

    # The fence watchdog stops every VM once the control plane's lease lapses (docs/nest.md, Fence watchdog). It runs
    # apart from kestrel-host, with no ordering or requirement on it: a hung or dead agent must not keep a VM serving.
    systemd.services.kestrel-fence = {
      description = "Nest fence watchdog (stops VMs past the lease in lease.json)";
      wantedBy = [ "multi-user.target" ];
      path = with pkgs; [ systemd coreutils ];
      serviceConfig = {
        ExecStart = "${packages."kestrel-host"}/bin/kestrel-host fence --config ${configFile}";
        Restart = "always";
        RestartSec = 2;
      };
    };

    systemd.services.kestrel-depcache = {
      description = "Nest dependency cache (read-only for VMs)";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      serviceConfig = hardened // {
        ExecStart = "${packages."kestrel-depcache"}/bin/kestrel-depcache --listen ${depcacheListen} --storage-dir /var/cache/kestrel-depcache --public-base-url http://${depcacheListen}";
        User = "kestrel-depcache";
        Group = "kestrel-depcache";
        ReadWritePaths = [ "/var/cache/kestrel-depcache" ];
        Restart = "always";
        RestartSec = 2;
      };
    };

    systemd.services.kestrel-ingress = {
      description = "Nest ingress (route, hold, wake)";
      wantedBy = [ "multi-user.target" ];
      after = [ "kestrel-host.service" ];
      serviceConfig = hardened // {
        ExecStart = "${packages."kestrel-ingress"}/bin/kestrel-ingress --listen ${ingressListen} --api-socket ${apiSocket} --domain-suffix ${cfg.slug}.${cfg.domain}";
        User = "kestrel-ingress";
        Group = "kestrel-ingress";
        Restart = "always";
        RestartSec = 2;
      };
    };

    # The static, signed Nix binary cache: only the guest closure and a pinned set, written by
    # `nix copy --to file:///var/cache/kestrel-nix`. Never the host's own store.
    systemd.services.kestrel-nix-cache = {
      description = "Nest Nix binary cache (static, read-only)";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      serviceConfig = hardened // {
        ExecStart = "${pkgs.python3}/bin/python3 -m http.server --bind ${hostAddress} --directory /var/cache/kestrel-nix 5000";
        DynamicUser = true;
        Restart = "always";
        RestartSec = 2;
      };
    };

    services.caddy = {
      enable = true;
      package = pkgs.caddy.withPlugins {
        plugins = [ acmeDns.plugin ];
        hash = acmeDns.hash;
      };
      environmentFile = cfg.acme.environmentFile;
      virtualHosts."*.${cfg.slug}.${cfg.domain}" = {
        extraConfig = ''
          tls {
            dns ${acmeDns.tls}
          }
          reverse_proxy ${ingressListen}
        '';
      };
    };

    services.coturn = lib.mkIf cfg.turn.enable {
      enable = true;
      use-auth-secret = true;
      static-auth-secret-file = "${secretsDir}/turn-secret";
      no-cli = true;
      extraConfig = ''
        denied-peer-ip=10.77.0.0-10.77.255.255
        denied-peer-ip=169.254.0.0-169.254.255.255
        denied-peer-ip=10.0.0.0-10.255.255.255
        denied-peer-ip=172.16.0.0-172.31.255.255
        denied-peer-ip=192.168.0.0-192.168.255.255
        denied-peer-ip=100.64.0.0-100.127.255.255
        denied-peer-ip=127.0.0.0-127.255.255.255
        denied-peer-ip=::1-::1
        denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
        denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
      '';
    };
  };
}
