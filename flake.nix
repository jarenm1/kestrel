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
          # Local control plane (`wrangler dev`); nixpkgs' build runs workerd on NixOS
          wrangler
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

        # `nix run`: full local stack with no cloud dependency: Worker control plane via `wrangler dev`
        #   (http://127.0.0.1:8788, dev sign-in), a box connected to it, and Vite on http://localhost:5173.
        # `nix run .#box`: box only, sandboxed agents. Sources ./.box.env (gitignored) for the
        #   production control-plane URL and box token.
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
                # Separate from a production box on the same machine.
                export CLOUDAGENTS_DATA_DIR="''${CLOUDAGENTS_DEV_DATA_DIR:-$PWD/.data-dev}"
                # Several people can run this on one shared machine: each Linux user gets its own
                # block of ports (offset 10 per uid above 1000). The box never takes 8787, which
                # belongs to the production box.
                uid=$(id -u)
                offset="''${KESTREL_DEV_OFFSET:-$(( uid >= 1000 ? (uid - 1000) * 10 : 0 ))}"
                control_port=$((8788 + offset))
                export KESTREL_CONTROL_PORT=$control_port
                export KESTREL_APP_PORT=$((5173 + offset))
                export CLOUDAGENTS_PORT="''${CLOUDAGENTS_PORT:-$((8797 + offset))}"
                vars=packages/control/.dev.vars
                if [ ! -f "$vars" ]; then
                  token=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
                  printf 'BOX_TOKEN=%s\nDEV_SESSION_LOGIN=dev\nALLOWED_GITHUB_LOGINS=dev\n' "$token" > "$vars"
                  echo "created $vars (dev sign-in as 'dev')"
                fi
                CLOUDAGENTS_BOX_TOKEN=$(sed -n 's/^BOX_TOKEN=//p' "$vars")
                export CLOUDAGENTS_BOX_TOKEN
                export CLOUDAGENTS_CONTROL_URL="http://127.0.0.1:$control_port"
                if [ ! -d packages/app/dist ]; then
                  bun run build:app
                fi
                trap 'kill 0' EXIT
                # PATH wrangler from Nix: the npm workerd binary does not run on NixOS.
                (cd packages/control && wrangler dev --port "$control_port" --inspector-port $((9229 + offset)) --ip 127.0.0.1) &
                bun run --filter @cloudagents/server dev &
                bun run --filter @cloudagents/app dev &
                echo "ports: app $KESTREL_APP_PORT, worker $control_port, box $CLOUDAGENTS_PORT" >&2
                echo "open http://localhost:$KESTREL_APP_PORT/auth/dev-login to sign in" >&2
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
                  # shellcheck source=/dev/null
                  . ./.box.env
                  set +a
                fi
                exec bun run --filter @cloudagents/server dev
              '';
            };
            # Production box that follows `main`: keeps its own clone (never your working checkout),
            # polls origin every KESTREL_BOX_POLL seconds, and on a new commit fast-forwards,
            # reinstalls deps and restarts the box. A restart interrupts in-flight agent runs.
            boxAutoRun = pkgs.writeShellApplication {
              name = "cloudagents-box-auto";
              runtimeInputs = systemDeps ++ [ pkgs.util-linux ];
              text = ''
                dir="''${KESTREL_BOX_DIR:-$HOME/.local/share/kestrel-box}"
                repo="''${KESTREL_BOX_REPO:-https://github.com/jarenm1/kestrel.git}"
                interval="''${KESTREL_BOX_POLL:-60}"
                if [ ! -d "$dir/.git" ]; then
                  git clone --branch main "$repo" "$dir"
                fi
                if [ ! -f "$dir/.box.env" ]; then
                  if [ -f .box.env ]; then
                    install -m 600 .box.env "$dir/.box.env"
                  else
                    echo "missing $dir/.box.env (CLOUDAGENTS_CONTROL_URL, CLOUDAGENTS_BOX_TOKEN)" >&2
                    exit 1
                  fi
                fi
                cd "$dir"

                child=""
                stop() {
                  if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then
                    kill -TERM -- "-$child" 2>/dev/null || true
                    wait "$child" 2>/dev/null || true
                  fi
                  child=""
                }
                start() {
                  echo "box-auto: starting box at $(git rev-parse --short HEAD)" >&2
                  bun install --frozen-lockfile >/dev/null
                  # Own process group, so a restart stops bun and every agent under it.
                  setsid nix run .#box &
                  child=$!
                }
                trap 'stop; exit 0' INT TERM

                start
                while true; do
                  sleep "$interval" &
                  wait $! || true
                  if ! kill -0 "$child" 2>/dev/null; then
                    echo "box-auto: box exited; restarting" >&2
                    start
                    continue
                  fi
                  git fetch -q origin main || { echo "box-auto: fetch failed; will retry" >&2; continue; }
                  if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
                    echo "box-auto: main moved to $(git rev-parse --short origin/main); updating" >&2
                    stop
                    git reset -q --hard origin/main
                    start
                  fi
                done
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
            box-auto = {
              type = "app";
              program = "${boxAutoRun}/bin/cloudagents-box-auto";
            };
          };

        formatter = pkgs.nixpkgs-fmt;
      });
}
