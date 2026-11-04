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

        # Kept together so a stock Linux box can install the same desktop as the dev stack.
        desktopDeps = with pkgs; [
          weston
          xwayland
          openbox
          hsetroot
          xterm
          xdotool
          pulseaudio
          ffmpeg-full.bin
          xdamageCapture
        ];
        desktopEnv = assert pkgs.lib.versionAtLeast pkgs.weston.version "14"; pkgs.buildEnv {
          name = "kestrel-desktop-deps";
          paths = desktopDeps;
          pathsToLink = [ "/bin" ];
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
          # Local control plane (`wrangler dev`); nixpkgs' build runs workerd on NixOS
          wrangler
        ] ++ desktopDeps;

        # The sandbox has no /etc/fonts, so the browser gets its font config explicitly.
        sandboxFontsConf = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
        sandboxFirefox = pkgs.writeShellScriptBin "firefox" ''
          export FONTCONFIG_FILE=${sandboxFontsConf}
          exec ${pkgs.firefox}/bin/firefox "$@"
        '';
        # xterm's bitmap fonts don't scale, so it draws DejaVu at the desktop's HiDPI factor (GDK_SCALE, set by the box).
        # Colors and padding follow the app's palette (packages/app/src/styles.css).
        xtermStyle = pkgs.lib.escapeShellArgs (pkgs.lib.concatMap (r: [ "-xrm" "XTerm*${r}" ]) [
          "background: #0a0a0b"
          "foreground: #ededef"
          "cursorColor: #ededef"
          "highlightColor: #2e2e33"
          "highlightTextColor: #ededef"
          "scrollBar: false"
          "color0: #3a3a40"
          "color1: #f2555a"
          "color2: #4ade80"
          "color3: #e3b341"
          "color4: #6b9bff"
          "color5: #c084fc"
          "color6: #5ccfe6"
          "color7: #c8c8cd"
          "color8: #6b6b74"
          "color9: #ff7b7f"
          "color10: #86efac"
          "color11: #f0c95e"
          "color12: #93b6ff"
          "color13: #d8b4fe"
          "color14: #8fe1f0"
          "color15: #f5f5f6"
        ]);
        sandboxXterm = pkgs.writeShellScriptBin "xterm" ''
          export FONTCONFIG_FILE=${sandboxFontsConf}
          scale=''${GDK_SCALE:-1}
          exec ${pkgs.xterm}/bin/xterm -fa 'DejaVu Sans Mono' -fs "$(( 10 * scale ))" -b "$(( 8 * scale ))" \
            ${xtermStyle} "$@"
        '';

        # Antigravity CLI 1.5 (nixpkgs has 1.4, before `agy acp --login` and `session/resume`): the same package on
        # Google's 1.5.0 build, from the manifests its installer reads.
        agy = pkgs.antigravity-cli.overrideAttrs (_: {
          version = "1.5.0";
          src = pkgs.fetchurl {
            x86_64-linux = {
              url = "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.0-5269980577660928/linux-x64/cli_linux_x64.tar.gz";
              hash = "sha512-5gMfhQkpIQcF2MI5OlZluCuMOxloSm08VWyvox8m93rL8WTf7pbKhKWudnCsDMI4qXTJgcUXsmkZS9zP8nHL1Q==";
            };
            aarch64-linux = {
              url = "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.0-5269980577660928/linux-arm/cli_linux_arm64.tar.gz";
              hash = "sha512-UJUYsoIJRdsr6l4BPKQ6Sd9ceJJ8OsNBoRFSh9UmJzVuHpUGrA0gQPtGeRX7pN3pAGHQkf3b3fjdwhJjeuQBUA==";
            };
            aarch64-darwin = {
              url = "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.0-5269980577660928/darwin-arm/cli_mac_arm64.tar.gz";
              hash = "sha512-gzoKGKQY9wufuLKxpMTcVx8bFotRBKowN5RjaVlGzMAgHNSPnP0wIx62aK5tB+/htJphnMqhT37ihh+eBJ7ivg==";
            };
          }.${system};
        });

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
            opencode
            agy
            sandboxXterm # the task desktop's terminal and what the agent launches on it run sandboxed
            sandboxFirefox # a browser for desktop_launch
          ];
        };
        sandboxSsl = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";

        # Toolkits: heavy desktop apps a task opts into (the agent's `toolkit_install`), never part of
        # sandboxEnv. The box realizes `packages.toolkit-<name>` on demand with `nix build`, so a box
        # downloads Blender or Wine only once some task asks for it. Names match packages/server/src/sandbox/toolkits.ts.
        # Every binary is wrapped for the sandbox. Desktop sandboxes see the host GPU and its drivers at
        # /run/opengl-driver (NixOS); without them, GL and Vulkan come from Mesa's software drivers (llvmpipe, lavapipe).
        toolkitSoftwareGl = ''
          if [ ! -d /run/opengl-driver/lib ]; then
            export LD_LIBRARY_PATH="${pkgs.mesa}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
            export __EGL_VENDOR_LIBRARY_FILENAMES=${pkgs.mesa}/share/glvnd/egl_vendor.d/50_mesa.json
            export VK_DRIVER_FILES=${pkgs.mesa}/share/vulkan/icd.d/lvp_icd.${pkgs.stdenv.hostPlatform.uname.processor}.json
            export GALLIUM_DRIVER=llvmpipe
          fi
        '';
        toolkitWrapArgs = pkgs.lib.escapeShellArgs [
          "--run" toolkitSoftwareGl
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
        packages = toolkits // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          desktop-deps = desktopEnv;
        };

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
            # Production box that follows a git ref (KESTREL_BOX_REF, default `main`): keeps its own clone (never your
            # working checkout) and polls origin every KESTREL_BOX_POLL seconds. When the ref moves it waits until the box
            # is idle (no agent runs, no desktops, per the box's activity socket), then fast-forwards, reinstalls deps and
            # restarts. An update waits at most KESTREL_BOX_MAX_DEFER seconds for an idle box (0 = wait indefinitely).
            boxAutoRun = pkgs.writeShellApplication {
              name = "cloudagents-box-auto";
              runtimeInputs = systemDeps ++ [
                pkgs.util-linux
                pkgs.curl
                pkgs.jq
              ];
              text = ''
                dir="''${KESTREL_BOX_DIR:-$HOME/.local/share/kestrel-box}"
                repo="''${KESTREL_BOX_REPO:-https://github.com/jarenm1/kestrel.git}"
                ref="''${KESTREL_BOX_REF:-main}"
                interval="''${KESTREL_BOX_POLL:-60}"
                max_defer="''${KESTREL_BOX_MAX_DEFER:-21600}"
                case "$max_defer" in
                  "" | *[!0-9]*)
                    echo "box-auto: KESTREL_BOX_MAX_DEFER must be a whole number of seconds" >&2
                    exit 1
                    ;;
                esac
                if [ ! -d "$dir/.git" ]; then
                  git clone -q "$repo" "$dir"
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
                dir="$PWD"

                # The box serves its activity socket from its data dir: CLOUDAGENTS_DATA_DIR from .box.env, else .data.
                # shellcheck source=/dev/null
                data_dir="$(set -a && . ./.box.env && set +a && printf '%s' "''${CLOUDAGENTS_DATA_DIR:-$dir/.data}")"
                case "$data_dir" in
                  /*) ;;
                  *)
                    echo "box-auto: CLOUDAGENTS_DATA_DIR must be an absolute path (got $data_dir)" >&2
                    exit 1
                    ;;
                esac
                sock="$data_dir/box.sock"

                # Prints the target commit of the ref after fetching it; fails if the fetch fails.
                fetch_target() {
                  git fetch -q origin "$ref" && git rev-parse --verify -q 'FETCH_HEAD^{commit}'
                }
                # Prints "<runs> <desktops>" from the box; fails if the socket does not answer.
                activity() {
                  curl -sf --max-time 5 --unix-socket "$sock" http://box/activity |
                    jq -er '"\(.runs | numbers) \(.desktops | numbers)"'
                }

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

                if target="$(fetch_target)"; then
                  git reset -q --hard "$target"
                else
                  echo "box-auto: fetch of $ref failed; starting the current checkout" >&2
                fi
                start

                pending=""
                pending_since=0
                logged=""
                while true; do
                  sleep "$interval" &
                  wait $! || true
                  if ! kill -0 "$child" 2>/dev/null; then
                    echo "box-auto: box exited; restarting" >&2
                    start
                    continue
                  fi
                  if ! target="$(fetch_target)"; then
                    echo "box-auto: fetch of $ref failed; will retry" >&2
                    continue
                  fi
                  if [ "$(git rev-parse HEAD)" = "$target" ]; then
                    pending=""
                    continue
                  fi
                  if [ -z "$pending" ]; then
                    pending_since="$(date +%s)"
                  fi
                  pending="$target"
                  if [ "$max_defer" -gt 0 ] && [ "$(($(date +%s) - pending_since))" -ge "$max_defer" ]; then
                    echo "box-auto: $ref waited ''${max_defer}s for an idle box; updating now" >&2
                  elif counts="$(activity)"; then
                    read -r runs desktops <<<"$counts"
                    if [ "$runs" -gt 0 ] || [ "$desktops" -gt 0 ]; then
                      if [ "$logged" != "$target" ]; then
                        echo "box-auto: $ref moved to $(git rev-parse --short "$target"); deferring while busy ($runs runs, $desktops desktops)" >&2
                        logged="$target"
                      fi
                      continue
                    fi
                  else
                    echo "box-auto: no answer from $sock; updating without an idle check" >&2
                  fi
                  echo "box-auto: $ref moved to $(git rev-parse --short "$target"); updating" >&2
                  stop
                  git reset -q --hard "$target"
                  pending=""
                  logged=""
                  start
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
