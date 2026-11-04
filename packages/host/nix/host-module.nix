{ self }:

{ config, lib, pkgs, ... }:

let
  cfg = config.services.kestrel-nest;
  system = pkgs.stdenv.hostPlatform.system;
  packages = self.packages.${system};

  stateDir = "/var/lib/kestrel-host";
  secretsDir = "/etc/kestrel-host";
  apiSocket = "/run/kestrel-host/api.sock";
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
in
{
  options.services.kestrel-nest = {
    enable = lib.mkEnableOption "the Nest host (per-user VMs on Cloud Hypervisor)";

    slug = lib.mkOption {
      type = lib.types.strMatching "[a-z0-9-]+";
      description = "This host's DNS label; boxes are served at `<boxId>.<slug>.<domain>`.";
    };

    domain = lib.mkOption {
      type = lib.types.str;
      description = "The Nest domain (`nestDomain`). Caddy serves `*.<slug>.<domain>`.";
    };

    controlUrl = lib.mkOption {
      type = lib.types.str;
      description = "Base URL of the control plane the host agent connects to.";
    };

    uplink = lib.mkOption {
      type = lib.types.str;
      description = "Network interface guests reach the internet through (masqueraded).";
    };

    cpuVendor = lib.mkOption {
      type = lib.types.enum [ "intel" "amd" ];
      description = "Selects the IOMMU kernel parameters for GPU passthrough.";
    };

    gpu = {
      vendorDevices = lib.mkOption {
        type = lib.types.listOf (lib.types.strMatching "[0-9a-f]{4}:[0-9a-f]{4}");
        default = [ ];
        example = [ "10de:2684" ];
        description = "vendor:device IDs of GPUs bound to vfio-pci at boot (for on-demand attach).";
      };
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
      secretKeyFile = lib.mkOption {
        type = lib.types.str;
        default = "${secretsDir}/nix-cache-secret-key";
        description = "Signing key for the Nix cache, used when it is populated: `nix copy --to 'file:///var/cache/kestrel-nix?secret-key=<file>'`.";
      };
    };

    turn.enable = lib.mkEnableOption "coturn on the host for WebRTC (used when no routed IPv6 prefix is available)";
  };

  config = lib.mkIf cfg.enable {
    boot.kernelParams = iommuParams ++ [
      "transparent_hugepage=madvise"
    ] ++ lib.optional (cfg.gpu.vendorDevices != [ ]) "vfio-pci.ids=${gpuVendorDevice}";

    boot.kernelModules = [ "kvm" "vfio-pci" "ublk_drv" "vhost_vsock" "vhost_net" "tun" ];
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
          tcp dport 22 accept
          icmp type echo-request accept
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
        Restart = "always";
        RestartSec = 2;
      };
    };

    systemd.services.kestrel-host = {
      description = "Nest host agent";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" "kestrel-depcache.service" "kestrel-nix-cache.service" ];
      wants = [ "network-online.target" ];
      path = [ pkgs.cloud-hypervisor pkgs.iproute2 pkgs.nftables pkgs.xfsprogs packages."kestrel-volume" ];
      environment = {
        KESTREL_HOST_SLUG = cfg.slug;
        KESTREL_NEST_DOMAIN = cfg.domain;
        KESTREL_CONTROL_URL = cfg.controlUrl;
        KESTREL_HOST_STATE_DIR = stateDir;
        KESTREL_HOST_SECRETS_DIR = secretsDir;
        KESTREL_HOST_API_SOCKET = apiSocket;
        KESTREL_HOST_UPLINK = cfg.uplink;
        KESTREL_VOLUME_BIN = "${packages."kestrel-volume"}/bin/kestrel-volume";
        KESTREL_CLOUD_HYPERVISOR_BIN = "${pkgs.cloud-hypervisor}/bin/cloud-hypervisor";
        KESTREL_GUEST_IMAGE_STORE = "${stateDir}/templates";
        KESTREL_VM_SLICE = "kestrel-vms.slice";
        KESTREL_DEPCACHE_URL = "http://${depcacheListen}";
        KESTREL_NIX_CACHE_URL = "http://${nixCacheListen}";
        KESTREL_NIX_CACHE_PUBLIC_KEY = cfg.nixCache.publicKey;
        KESTREL_NIX_CACHE_SECRET_KEY_FILE = cfg.nixCache.secretKeyFile;
      };
      serviceConfig = {
        ExecStart = "${packages."kestrel-host"}/bin/kestrel-host";
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

    systemd.services.kestrel-depcache = {
      description = "Nest dependency cache (read-only for VMs)";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      environment = {
        KESTREL_DEPCACHE_LISTEN = depcacheListen;
        KESTREL_DEPCACHE_DIR = "/var/cache/kestrel-depcache";
      };
      serviceConfig = hardened // {
        ExecStart = "${packages."kestrel-depcache"}/bin/kestrel-depcache";
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
      environment = {
        KESTREL_INGRESS_LISTEN = ingressListen;
        KESTREL_HOST_API_SOCKET = apiSocket;
        KESTREL_NEST_DOMAIN = "${cfg.slug}.${cfg.domain}";
      };
      serviceConfig = hardened // {
        ExecStart = "${packages."kestrel-ingress"}/bin/kestrel-ingress";
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
