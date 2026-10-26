{
  description = "cloudagents: cloud coding-agent platform MVP (TypeScript / Effect / web client)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };

        # Native / system dependencies. npm dependencies are pinned by bun.lock
        # and installed with `bun install` inside the dev shell.
        systemDeps = with pkgs; [
          # JS toolchain
          bun
          nodejs_22 # wrangler + some tooling expect node
          # VCS: git worktrees are the unit of parallel agent work
          git
          # Agent sandbox: every agent run and MCP exec runs inside bubblewrap
          bubblewrap
          # Remote desktop stack (one virtual X display per task)
          xvfb         # virtual X server (xorg.xvfb is deprecated)
          openbox       # minimal window manager
          xterm         # default app on agent desktops
          xdotool       # input injection (mouse/keyboard) from the web client / MCP
          ffmpeg-full   # x11grab capture -> H.264 -> fragmented MP4 (nixpkgs ffmpeg lacks x11grab)
          # Cloudflare demo deploy
          cloudflared
        ];

        # Toolchain visible inside the agent sandbox; PATH inside the sandbox is exactly this.
        sandboxEnv = pkgs.buildEnv {
          name = "cloudagents-sandbox-env";
          paths = with pkgs; [
            bash
            coreutils
            findutils
            gnugrep
            gnused
            gawk
            which
            procps
            git
            curl
            ripgrep
            nodejs_22
            bun
            claude-code
          ];
        };
        sandboxSsl = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
      in
      {
        devShells.default = pkgs.mkShell {
          packages = systemDeps;

          shellHook = ''
            export CLOUDAGENTS_ROOT="$PWD"
            export CLOUDAGENTS_DATA_DIR="''${CLOUDAGENTS_DATA_DIR:-$PWD/.data}"
            export CLOUDAGENTS_SANDBOX_PATH="${sandboxEnv}/bin"
            export CLOUDAGENTS_SANDBOX_SSL="${sandboxSsl}"
            export PATH="$PWD/node_modules/.bin:$PATH"
            echo "cloudagents dev shell: bun $(bun --version), ffmpeg $(ffmpeg -version | head -1 | cut -d' ' -f3)"
          '';
        };

        # `nix run`: server on http://127.0.0.1:8787 and web dev server on http://localhost:5173.
        # `nix run .#box`: server only, agent runs sandboxed. Sources ./.box.env (gitignored) for secrets.
        apps =
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
              if [ ! -d node_modules ]; then
                bun install --frozen-lockfile
              fi
            '';
            devRun = pkgs.writeShellApplication {
              name = "cloudagents-dev";
              runtimeInputs = systemDeps;
              text = ''
                ${preflight}
                trap 'kill $(jobs -p) 2>/dev/null || true' EXIT
                bun run --filter @cloudagents/server dev &
                bun run --filter @cloudagents/web dev &
                wait -n
              '';
            };
            boxRun = pkgs.writeShellApplication {
              name = "cloudagents-box";
              runtimeInputs = systemDeps;
              text = ''
                ${preflight}
                if [ -f .box.env ]; then
                  set -a
                  . ./.box.env
                  set +a
                fi
                exec bun run --filter @cloudagents/server dev
              '';
            };
          in
          {
            default = {
              type = "app";
              program = "${devRun}/bin/cloudagents-dev";
            };
            box = {
              type = "app";
              program = "${boxRun}/bin/cloudagents-box";
            };
          };

        formatter = pkgs.nixpkgs-fmt;
      });
}
