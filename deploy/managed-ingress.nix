{ config, lib, ... }:
let
  cfg = config.services.kestrelIngress;
in
{
  options.services.kestrelIngress = {
    enable = lib.mkEnableOption "Kestrel HTTPS/WSS ingress over a private WireGuard tunnel";
    hostname = lib.mkOption { type = lib.types.str; description = "DNS-only public hostname pointing at this ingress host."; };
    privateKeyFile = lib.mkOption { type = lib.types.str; description = "Absolute path to this host's WireGuard private key; never a Nix store path."; };
    boxPublicKey = lib.mkOption { type = lib.types.str; description = "WireGuard public key of the managed box."; };
    listenPort = lib.mkOption { type = lib.types.port; default = 51820; };
    boxPort = lib.mkOption { type = lib.types.port; default = 8787; };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      { assertion = builtins.match "[a-zA-Z0-9.-]+" cfg.hostname != null; message = "kestrelIngress.hostname must be a DNS hostname."; }
      { assertion = lib.hasPrefix "/" cfg.privateKeyFile && !(lib.hasPrefix "/nix/store/" cfg.privateKeyFile); message = "Keep the WireGuard private key outside the Nix store."; }
    ];
    networking.firewall.allowedTCPPorts = [ 80 443 ];
    networking.firewall.allowedUDPPorts = [ cfg.listenPort ];
    networking.wireguard.interfaces.kestrel = {
      ips = [ "10.203.0.1/32" ];
      inherit (cfg) privateKeyFile listenPort;
      peers = [{ publicKey = cfg.boxPublicKey; allowedIPs = [ "10.203.0.2/32" ]; }];
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
          reverse_proxy 10.203.0.2:${toString cfg.boxPort}
        '';
      };
    };
  };
}
