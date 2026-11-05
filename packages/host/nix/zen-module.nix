{ config, lib, utils, ... }:
let
  cfg = config.services.kestrelZenDdc;
  # Compare on path components so "/etcetera" is not treated as "/etc" and ".." cannot
  # climb out of the configured directory.
  dataDirParts = lib.filter (part: part != "" && part != ".") (lib.splitString "/" cfg.dataDir);
  dataDir = "/" + lib.concatStringsSep "/" dataDirParts;
  hasParentTraversal = lib.any (part: part == "..") dataDirParts;
  # ReadWritePaths on one of these roots would make the whole system tree writable.
  systemRoots = [
    "/bin" "/boot" "/dev" "/etc" "/home" "/lib" "/lib64" "/nix" "/proc"
    "/root" "/run" "/sbin" "/sys" "/tmp" "/usr" "/var"
  ];
  inSystemRoot = root:
    (dataDir == root || lib.hasPrefix "${root}/" dataDir)
    && !(root == "/var" && lib.hasPrefix "/var/lib/" dataDir);
  # A CIDR must have an explicit prefix no broader than /8 (IPv4) or /16 (IPv6), so 0.0.0.0/0,
  # ::/0 and 10.0.0.0/0 are rejected: systemd masks host bits, so a /0 admits every address.
  validNetwork = n:
    let
      parts = lib.splitString "/" n;
      len = lib.last parts;
      isV6 = lib.hasInfix ":" n;
    in
      builtins.length parts == 2
      && builtins.match "[0-9]+" len != null
      && lib.toInt len >= (if isV6 then 16 else 8);
in {
  options.services.kestrelZenDdc = {
    enable = lib.mkEnableOption "isolated operator-supplied Zen DDC";
    executable = lib.mkOption { type = lib.types.str; description = "Absolute path to the operator-supplied Zen executable or FHS wrapper."; };
    configFile = lib.mkOption { type = lib.types.str; description = "Absolute path to the operator-supplied Zen Lua configuration."; };
    dataDir = lib.mkOption { type = lib.types.str; description = "Absolute, dedicated Zen data directory at least one level below a top-level directory and outside system roots such as /etc, /var (except /var/lib), /run and /usr. Provisioned and quota-limited by the operator."; };
    allowedNetworks = lib.mkOption { type = lib.types.listOf lib.types.str; default = []; description = "Explicit trusted private client CIDRs, enforced by systemd IP filtering. Never include public or unrelated tenant networks."; };
    memoryMax = lib.mkOption { type = lib.types.str; default = "4G"; description = "systemd MemoryMax."; };
    cpuQuota = lib.mkOption { type = lib.types.str; default = "200%"; description = "systemd CPUQuota."; };
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      { assertion = cfg.allowedNetworks != []; message = "Zen requires an explicit trusted private network ACL."; }
      { assertion = lib.all (p: lib.hasPrefix "/" p) [ cfg.executable cfg.configFile cfg.dataDir ]; message = "Zen paths must be absolute."; }
      { assertion = builtins.length dataDirParts >= 2 && !hasParentTraversal && !lib.any inSystemRoot systemRoots; message = "Zen dataDir must be a dedicated directory at least one level below a top-level directory, must not contain '..', and must stay outside system roots such as /etc, /var (except /var/lib), /run, /usr, /boot, /nix, /home or /root (for example /srv/zen-data)."; }
      { assertion = lib.all validNetwork cfg.allowedNetworks; message = "Zen allowedNetworks must be explicit CIDRs with a prefix no broader than /8 (IPv4) or /16 (IPv6), for example 10.20.0.0/16 or fd00:20::/48; 0.0.0.0/0, ::/0 and bare addresses are rejected."; }
    ];
    users.groups.kestrel-zen = {};
    users.users.kestrel-zen = { isSystemUser = true; group = "kestrel-zen"; };
    systemd.services.kestrel-zen-ddc = {
      description = "Operator-supplied Zen shared DDC";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      serviceConfig = {
        User = "kestrel-zen";
        Group = "kestrel-zen";
        ExecStart = utils.escapeSystemdExecArgs [ cfg.executable "--config=${cfg.configFile}" ];
        Restart = "on-failure";
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ReadWritePaths = [ dataDir ];
        IPAddressDeny = "any";
        IPAddressAllow = cfg.allowedNetworks;
        MemoryMax = cfg.memoryMax;
        CPUQuota = cfg.cpuQuota;
      };
    };
  };
}
