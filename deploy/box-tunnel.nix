{ config, lib, ... }:
let
  cfg = config.services.kestrelBoxTunnel;
in
{
  options.services.kestrelBoxTunnel = {
    enable = lib.mkEnableOption "outbound WireGuard tunnel from a NAT'd box to its box-ingress host";
    privateKeyFile = lib.mkOption {
      type = lib.types.str;
      description = "Absolute path to the box's WireGuard private key; never a Nix store path.";
    };
    ingressPublicKey = lib.mkOption {
      type = lib.types.str;
      description = "WireGuard public key of the ingress host.";
    };
    endpoint = lib.mkOption {
      type = lib.types.str;
      description = "Ingress public hostname or IP and UDP port, e.g. ingress.example.com:51820.";
    };
    boxPort = lib.mkOption {
      type = lib.types.port;
      default = 8787;
      description = "Port the box listens on; opened on the tunnel interface only.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [{
      assertion = lib.hasPrefix "/" cfg.privateKeyFile && !(lib.hasPrefix "/nix/store/" cfg.privateKeyFile);
      message = "Keep the WireGuard private key outside the Nix store.";
    }];
    networking.wireguard.interfaces.kestrel = {
      ips = [ "10.203.0.2/32" ];
      inherit (cfg) privateKeyFile;
      peers = [{
        publicKey = cfg.ingressPublicKey;
        inherit (cfg) endpoint;
        allowedIPs = [ "10.203.0.1/32" ];
        persistentKeepalive = 25;
      }];
    };
    # No public inbound box port. The ingress is the only permitted tunnel peer.
    networking.firewall.interfaces.kestrel.allowedTCPPorts = [ cfg.boxPort ];
  };
}
