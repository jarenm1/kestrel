{ config, lib, ... }:
let
  cfg = config.services.kestrelZenDdc;
in {
  options.services.kestrelZenDdc = {
    enable = lib.mkEnableOption "isolated operator-supplied Zen DDC";
    executable = lib.mkOption { type = lib.types.str; description = "Absolute path to the operator-supplied Zen executable or FHS wrapper."; };
    configFile = lib.mkOption { type = lib.types.str; description = "Absolute path to the operator-supplied Zen Lua configuration."; };
    dataDir = lib.mkOption { type = lib.types.str; description = "Absolute, dedicated Zen data directory, provisioned and quota-limited by the operator."; };
    allowedNetworks = lib.mkOption { type = lib.types.listOf lib.types.str; default = []; description = "Explicit trusted private client CIDRs, enforced by systemd IP filtering. Never include public or unrelated tenant networks."; };
    memoryMax = lib.mkOption { type = lib.types.str; default = "4G"; description = "systemd MemoryMax."; };
    cpuQuota = lib.mkOption { type = lib.types.str; default = "200%"; description = "systemd CPUQuota."; };
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      { assertion = cfg.allowedNetworks != []; message = "Zen requires an explicit trusted private network ACL."; }
      { assertion = lib.all (p: lib.hasPrefix "/" p) [ cfg.executable cfg.configFile cfg.dataDir ]; message = "Zen paths must be absolute."; }
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
        ExecStart = "${lib.escapeSystemdExecArg cfg.executable} --config=${lib.escapeSystemdExecArg cfg.configFile}";
        Restart = "on-failure";
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ReadWritePaths = [ cfg.dataDir ];
        IPAddressDeny = "any";
        IPAddressAllow = cfg.allowedNetworks;
        MemoryMax = cfg.memoryMax;
        CPUQuota = cfg.cpuQuota;
      };
    };
  };
}
