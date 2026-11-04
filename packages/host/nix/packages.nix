# Packages for the Nest: the Bun services (box, host agent) and the Rust crates (guest agent, volume, ingress,
# depcache). Consumed by flake.nix (`packages.<system>.kestrel-*`) and guest.nix.
{ pkgs, lib, root }:

let
  # Workspace manifests only: `bun install` resolves from these, so the dependency closure does not change
  # when source files do.
  workspaceManifests = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions ([
      (root + "/package.json")
      (root + "/bun.lock")
    ] ++ map (name: root + "/packages/${name}/package.json")
      (builtins.attrNames (lib.filterAttrs (_: t: t == "directory") (builtins.readDir (root + "/packages")))));
  };

  # node_modules for one workspace filter (and the workspace packages it depends on), installed from the
  # manifests. Fixed output: bun fetches from the registry at build time.
  nodeModulesFor = { name, filter, hash }: pkgs.stdenvNoCC.mkDerivation {
    name = "${name}-node-modules";
    src = workspaceManifests;
    nativeBuildInputs = [ pkgs.bun ];
    dontConfigure = true;
    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      bun install --frozen-lockfile --ignore-scripts --filter ${lib.escapeShellArg filter}
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -a node_modules $out/
      for dir in packages/*/; do
        if [ -d "$dir/node_modules" ]; then
          mkdir -p "$out/$dir"
          cp -a "$dir/node_modules" "$out/$dir/"
        fi
      done
      runHook postInstall
    '';
    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = hash;
  };

  # A Bun service run from its source tree: `bun run <entry>` in `<package>`, with node_modules from `nodeModulesFor`.
  # `sources` are the workspace paths the service needs (its own source, the workspace packages it imports).
  bunApp = { name, package, filter, hash, sources, entry }:
    let
      deps = nodeModulesFor { inherit name filter hash; };
      tree = lib.fileset.toSource {
        inherit root;
        fileset = lib.fileset.unions ([ (root + "/package.json") ] ++ map (path: root + "/${path}") sources);
      };
    in
    pkgs.stdenvNoCC.mkDerivation {
      name = name;
      dontUnpack = true;
      nativeBuildInputs = [ pkgs.makeWrapper ];
      installPhase = ''
        runHook preInstall
        app=$out/lib/${name}
        mkdir -p $app $out/bin
        cp -r --no-preserve=mode ${tree}/. $app/
        cp -r --no-preserve=mode ${deps}/. $app/
        makeWrapper ${pkgs.bun}/bin/bun $out/bin/${name} \
          --chdir $app/packages/${package} \
          --add-flags "run ${entry}"
        runHook postInstall
      '';
    };

  box = bunApp {
    name = "kestrel-box";
    package = "server";
    filter = "@cloudagents/server";
    hash = "sha256-ZAvSjA/bznNIY+Xk1jZbac2JjKeKfd8ykugFKJRfV3Y=";
    sources = [ "packages/protocol" "packages/server" ];
    entry = "src/main.ts";
  };

  host = bunApp {
    name = "kestrel-host";
    package = "host";
    filter = "@cloudagents/host";
    hash = "sha256-aEBZV6qseG+rCOOWrR8l+6lRlUR+/xEbLUM89k6Hop0=";
    sources = [ "packages/protocol" "packages/host/package.json" "packages/host/src" ];
    entry = "src/cli.ts";
  };

  crate = { name, static ? false, bindgen ? false }:
    let
      set = if static then pkgs.pkgsStatic else pkgs;
      dir = root + "/packages/host/crates/${name}";
    in
    set.rustPlatform.buildRustPackage {
      pname = name;
      version = "0.1.0";
      src = dir;
      cargoLock.lockFile = dir + "/Cargo.lock";
      nativeBuildInputs = lib.optional bindgen set.rustPlatform.bindgenHook;
    };
in
{
  inherit box host;
  guest-agent = crate { name = "guest-agent"; static = true; };
  volume = crate { name = "volume"; bindgen = true; };
  ingress = crate { name = "ingress"; };
  depcache = crate { name = "depcache"; };
}
