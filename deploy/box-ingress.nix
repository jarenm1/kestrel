{ config, lib, ... }:
let
  cfg = config.services.kestrelBoxIngress;
  wg = cfg.wireguard;
  # With WireGuard the box is the tunnel peer at 10.203.0.2; otherwise it runs on this host.
  upstream = if wg.enable then "10.203.0.2:${toString wg.boxPort}" else cfg.upstream;
  isKeyPath = p: lib.hasPrefix "/" p && !(lib.hasPrefix "/nix/store/" p);
in
{
  options.services.kestrelBoxIngress = {
    enable = lib.mkEnableOption "HTTPS/WSS ingress for one Kestrel managed box";
    hostname = lib.mkOption {
      type = lib.types.str;
      description = "DNS-only public hostname of the box (not proxied through Cloudflare).";
    };
    upstream = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1:8787";
      description = "host:port of a box running on this host. Ignored when wireguard.enable is set.";
    };
    wireguard = {
      enable = lib.mkEnableOption "a WireGuard server on this host, for a box behind NAT that dials in";
      privateKeyFile = lib.mkOption {
        type = lib.types.str;
        description = "Absolute path to this host's WireGuard private key; never a Nix store path.";
      };
      peerPublicKey = lib.mkOption {
        type = lib.types.str;
        description = "WireGuard public key of the box (the tunnel peer at 10.203.0.2).";
      };
      listenPort = lib.mkOption {
        type = lib.types.port;
        default = 51820;
        description = "UDP port the WireGuard server listens on.";
      };
      boxPort = lib.mkOption {
        type = lib.types.port;
        default = 8787;
        description = "Port the box listens on inside the tunnel.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = builtins.match "[a-zA-Z0-9.-]+" cfg.hostname != null;
        message = "kestrelBoxIngress.hostname must be a DNS hostname.";
      }
      {
        assertion = !wg.enable || isKeyPath wg.privateKeyFile;
        message = "Keep the WireGuard private key outside the Nix store.";
      }
    ];

    networking.firewall.allowedTCPPorts = [ 80 443 ];
    networking.firewall.allowedUDPPorts = lib.optional wg.enable wg.listenPort;

    networking.wireguard.interfaces.kestrel = lib.mkIf wg.enable {
      ips = [ "10.203.0.1/32" ];
      inherit (wg) privateKeyFile listenPort;
      peers = [{ publicKey = wg.peerPublicKey; allowedIPs = [ "10.203.0.2/32" ]; }];
    };

    services.caddy = {
      enable = true;
      # Proxy errors may contain request URLs too; remove request metadata from runtime logs.
      logFormat = ''
        level ERROR
        format filter {
          wrap json
          fields {
            request delete
          }
        }
      '';
      virtualHosts.${cfg.hostname} = {
        logFormat = "output discard";
        extraConfig = ''
          # MCP and the credential broker are local sandbox interfaces, never public APIs.
          @private path /mcp /mcp/* /broker /broker/*
          respond @private 404
          reverse_proxy ${upstream}
        '';
      };
    };
  };
}
