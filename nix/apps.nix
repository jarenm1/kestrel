{ pkgs, self, systemDeps, sandboxEnv, sandboxSsl }:
let
  preflight = ''
    if [ ! -f flake.nix ] || [ ! -f package.json ]; then
      echo "run from the cloudagents repo root" >&2
      exit 1
    fi
    export CLOUDAGENTS_ROOT="$PWD"
    export CLOUDAGENTS_DATA_DIR="''${CLOUDAGENTS_DATA_DIR:-$PWD/.data}"
    export CLOUDAGENTS_SANDBOX_PATH="${sandboxEnv}/bin"
    export CLOUDAGENTS_SANDBOX_SSL="${sandboxSsl}"
    export CLOUDAGENTS_TOOLKITS_FLAKE="${self}"
    if [ ! -d node_modules ]; then
      bun install --frozen-lockfile
    fi
  '';
  devRun = pkgs.writeShellApplication {
    name = "cloudagents-dev";
    runtimeInputs = systemDeps;
    text = ''
      ${preflight}
      export KESTREL_WRANGLER=${pkgs.wrangler}/bin/wrangler
      exec bun run dev
    '';
  };
  boxRun = pkgs.writeShellApplication {
    name = "cloudagents-box";
    runtimeInputs = systemDeps;
    text = ''
      ${preflight}
      if [ -f .box.env ]; then
        set -a
        # shellcheck source=/dev/null
        . ./.box.env
        set +a
      fi
      exec bun run --filter @cloudagents/server dev
    '';
  };
  boxAutoRun = pkgs.writeShellApplication {
    name = "cloudagents-box-auto";
    runtimeInputs = systemDeps ++ [ pkgs.util-linux pkgs.curl pkgs.jq ];
    text = builtins.readFile ../scripts/box-auto.sh;
  };
in
{
  default = { type = "app"; program = "${devRun}/bin/cloudagents-dev"; };
  box = { type = "app"; program = "${boxRun}/bin/cloudagents-box"; };
  box-auto = { type = "app"; program = "${boxAutoRun}/bin/cloudagents-box-auto"; };
}
