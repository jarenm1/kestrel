# The Nest guest image: kernel, initrd, the erofs Nix store, the kernel command line and a
# manifest (docs/nest.md, "The guest image"). Built by the flake as `packages.nest-guest`.
{ nixpkgs, system, root, self, systemDeps, sandboxEnv, sandboxSsl }:

let
  lib = nixpkgs.lib;
  pkgs = import nixpkgs {
    inherit system;
    config.allowUnfree = true;
  };
  nest = import ./packages.nix { inherit pkgs lib root; };

  nixos = lib.nixosSystem {
    inherit system;
    specialArgs = {
      guest = {
        agent = nest.guest-agent;
        box = nest.box;
        inherit self;
      };
      inherit systemDeps sandboxEnv sandboxSsl;
    };
    modules = [ ./guest-module.nix ];
  };
  build = nixos.config.system.build;
  toplevel = build.toplevel;
  # The image is named by its system closure: the toplevel's store hash identifies every byte of it.
  imageId = lib.head (lib.splitString "-" (builtins.baseNameOf toplevel));

  # Every path of the system closure. The registration is kept outside `store/` so the guest can load it
  # into the Nix database without the database being part of the closure it describes.
  closure = pkgs.closureInfo { rootPaths = [ toplevel ]; };

  # Image layout: `store/` holds store entries (the overlay lowerdir on /nix/store), `registration` the Nix
  # database rows for them (`nix-store --load-db`).
  store = pkgs.runCommand "kestrel-guest-store.erofs" { nativeBuildInputs = [ pkgs.erofs-utils ]; } ''
    mkdir -p root/store
    for path in $(cat ${closure}/store-paths); do
      cp -a "$path" root/store/
    done
    cp ${closure}/registration root/registration
    mkfs.erofs -T0 -U 00000000-0000-0000-0000-000000000000 $out root
    # Cloud Hypervisor maps pmem in 2 MiB units and refuses other sizes; trailing zeros are ignored by erofs.
    size=$(stat -c %s $out)
    truncate -s $(( (size + 2097151) / 2097152 * 2097152 )) $out
  '';

  kernelParams = nixos.config.boot.kernelParams ++ [ "init=${toplevel}/init" ];
  cmdline = pkgs.writeText "kestrel-guest-cmdline" (lib.concatStringsSep " " kernelParams + "\n");

  manifest = pkgs.writeText "kestrel-guest-manifest.json" (builtins.toJSON {
    inherit imageId;
    kernel = "kernel";
    initrd = "initrd";
    store = "store.erofs";
    cmdline = "cmdline";
  });
in
pkgs.runCommand "kestrel-guest-${imageId}" { } ''
  mkdir -p $out
  cp -L ${build.kernel}/${nixos.config.system.boot.loader.kernelFile} $out/kernel
  cp -L ${build.initialRamdisk}/${nixos.config.system.boot.loader.initrdFile} $out/initrd
  cp ${store} $out/store.erofs
  cp ${cmdline} $out/cmdline
  cp ${manifest} $out/manifest.json
''
