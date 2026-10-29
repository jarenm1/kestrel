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

        # Damage-driven X capture (packages/server/native): one raw frame per screen change for ffmpeg.
        xdamageCapture = pkgs.stdenv.mkDerivation {
          pname = "xdamage-capture";
          version = "0.1.0";
          src = ./packages/server/native;
          buildInputs = with pkgs; [ libX11 libXext libXdamage libXfixes ];
          buildPhase = ''
            $CC -std=gnu11 -O2 -Wall -Wextra -Werror -o xdamage-capture xdamage-capture.c -lX11 -lXext -lXdamage -lXfixes
          '';
          installPhase = ''
            install -Dm755 xdamage-capture $out/bin/xdamage-capture
          '';
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
          passt         # `pasta`: each task's own network namespace (no host loopback, no abstract sockets)
          util-linux    # `nsenter`: sandbox launches join their task's network namespace
          # Remote desktop stack (one virtual X display per task)
          xvfb         # virtual X server (xorg.xvfb is deprecated)
          openbox       # minimal window manager
          xterm         # default app on agent desktops
          xdotool       # input injection (mouse/keyboard) from the web client / MCP
          ffmpeg-full   # x11grab capture -> H.264 -> fragmented MP4 (nixpkgs ffmpeg lacks x11grab)
          xdamageCapture # frames from the X damage/cursor events -> ffmpeg rawvideo
          # Local control plane (`wrangler dev`); nixpkgs' build runs workerd on NixOS
          wrangler
        ];

        # The sandbox has no /etc/fonts, so the browser gets its font config explicitly.
        sandboxFontsConf = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
        sandboxFirefox = pkgs.writeShellScriptBin "firefox" ''
          export FONTCONFIG_FILE=${sandboxFontsConf}
          exec ${pkgs.firefox}/bin/firefox "$@"
        '';

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
            codex
            xterm # the task desktop's terminal and what the agent launches on it run sandboxed
            sandboxFirefox # a browser for desktop_launch
          ];
        };
        sandboxSsl = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";

        # Toolkits: heavy desktop apps a task opts into (the agent's `toolkit_install`), never part of
        # sandboxEnv. The box realizes `packages.toolkit-<name>` on demand with `nix build`, so a box
        # downloads Blender or Wine only once some task asks for it. Names match packages/server/src/sandbox/toolkits.ts.
        # Every binary is wrapped for the sandbox: Xvfb has no GPU and the sandbox has no /run/opengl-driver,
        # so GL and Vulkan come from Mesa's software drivers (llvmpipe, lavapipe).
        toolkitWrapArgs = pkgs.lib.escapeShellArgs [
          "--prefix" "LD_LIBRARY_PATH" ":" "${pkgs.mesa}/lib"
          "--set" "__EGL_VENDOR_LIBRARY_FILENAMES" "${pkgs.mesa}/share/glvnd/egl_vendor.d/50_mesa.json"
          "--set" "VK_DRIVER_FILES" "${pkgs.mesa}/share/vulkan/icd.d/lvp_icd.${pkgs.stdenv.hostPlatform.uname.processor}.json"
          "--set" "GALLIUM_DRIVER" "llvmpipe"
          "--set-default" "FONTCONFIG_FILE" "${sandboxFontsConf}"
          # Wine's X11 driver crashes on start when XDG_SESSION_TYPE is unset, as it is in the sandbox.
          "--set-default" "XDG_SESSION_TYPE" "x11"
        ];
        mkToolkit = name: apps: pkgs.runCommand "kestrel-toolkit-${name}" { nativeBuildInputs = [ pkgs.makeWrapper ]; } ''
          mkdir -p $out/bin
          for app in ${toString apps}; do
            for exe in "$app"/bin/*; do
              makeWrapper "$exe" "$out/bin/$(basename "$exe")" ${toolkitWrapArgs}
            done
          done
        '';
        # Vinegar with this sandbox's defaults, written only where the user has none yet:
        # - renderer Vulkan: Vinegar's default, DXVK, crashes Studio on lavapipe;
        # - Web Pages off: the embedded WebView2 sign-in never loads under Wine here, so Studio goes
        #   straight to its browser sign-in;
        # - a `roblox-studio-auth:` handler, so Firefox hands the signed-in link back to Vinegar.
        robloxVinegar = pkgs.writeShellScriptBin "vinegar" ''
          config="''${XDG_CONFIG_HOME:-$HOME/.config}"
          apps="''${XDG_DATA_HOME:-$HOME/.local/share}/applications"
          mkdir -p "$config/vinegar" "$apps"
          if [ ! -e "$config/vinegar/config.toml" ]; then
            printf '[studio]\nrenderer = "Vulkan"\nwebview = ""\n' > "$config/vinegar/config.toml"
          fi
          printf '%s\n' '[Desktop Entry]' 'Type=Application' 'Name=Vinegar' 'Exec=vinegar %u' 'NoDisplay=true' \
            'MimeType=x-scheme-handler/roblox-studio;x-scheme-handler/roblox-studio-auth;' > "$apps/kestrel-vinegar.desktop"
          if ! grep -qs 'roblox-studio-auth' "$config/mimeapps.list"; then
            printf '%s\n' '[Default Applications]' 'x-scheme-handler/roblox-studio=kestrel-vinegar.desktop' \
              'x-scheme-handler/roblox-studio-auth=kestrel-vinegar.desktop' >> "$config/mimeapps.list"
          fi
          exec ${pkgs.vinegar}/bin/vinegar "$@"
        '';
        # Wine opens links (Studio's "Login via Browser") with xdg-open, which the sandbox lacks.
        robloxXdgOpen = pkgs.writeShellScriptBin "xdg-open" ''
          case "$1" in
            roblox-studio:* | roblox-studio-auth:*) exec vinegar "$1" ;;
            *) exec firefox "$1" ;;
          esac
        '';
        # Vinegar is x86_64-linux only; the box is too, in practice.
        toolkits = pkgs.lib.optionalAttrs (system == "x86_64-linux") {
          toolkit-blender = mkToolkit "blender" [ pkgs.blender ];
          # Roblox Studio through Vinegar (Wine); Vinegar downloads Studio itself on first `vinegar run`.
          # Rojo and Wally sync and package the project from the workspace; Rojo still needs its Studio plugin.
          toolkit-roblox-studio = mkToolkit "roblox-studio" [ robloxVinegar robloxXdgOpen pkgs.rojo pkgs.wally ];
        };
      in
      {
        packages = toolkits;

        devShells.default = pkgs.mkShell {
          packages = systemDeps;

          shellHook = ''
            export CLOUDAGENTS_ROOT="$PWD"
            export CLOUDAGENTS_DATA_DIR="''${CLOUDAGENTS_DATA_DIR:-$PWD/.data}"
            export CLOUDAGENTS_SANDBOX_PATH="${sandboxEnv}/bin"
            export CLOUDAGENTS_SANDBOX_SSL="${sandboxSsl}"
            export CLOUDAGENTS_TOOLKITS_FLAKE="${self}"
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
                # Ports, .dev.vars and the three processes: scripts/dev.ts, which also runs without Nix.
                # The npm workerd binary does not run on NixOS; nixpkgs' wrangler does.
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
