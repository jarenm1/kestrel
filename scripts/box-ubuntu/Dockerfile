# Mimics a WSL/Ubuntu user box: non-Nix Ubuntu 24.04, a non-root user, agent CLIs installed under $HOME.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
# Node comes from NodeSource, not Ubuntu's nodejs (18.19): Pi's CLI needs Node >= 22.19. Install it before the npm
# globals below, and keep npm from the same distribution.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap git curl ca-certificates gnupg python3 python3-venv \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' \
 && rm -rf /var/lib/apt/lists/*

RUN (userdel -r ubuntu 2>/dev/null || true) \
 && useradd -m -s /bin/bash -u 1000 dev

USER dev
ENV HOME=/home/dev
ENV PATH=/home/dev/.local/bin:/home/dev/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /home/dev

# Claude Code: native installer -> ~/.local/bin/claude -> ~/.local/share/claude/versions/<v>
RUN curl -fsSL https://claude.ai/install.sh | bash

# Codex, OpenCode 2, Pi and its ACP adapter: npm globals under $HOME
RUN npm i -g @openai/codex @opencode/cli @earendil-works/pi-coding-agent pi-acp --prefix /home/dev/.npm-global

# Antigravity CLI: its own installer -> ~/.local/bin/agy
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash

# OMP: its own installer -> ~/.local/bin/omp
RUN curl -fsSL https://omp.sh/install | sh

# Hermes Agent: its own installer; the first run/setup pulls its runtime
RUN curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash

RUN node --version && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' \
 && claude --version && codex --version && opencode --version && agy --version && omp --version \
 && pi-acp --version && pi --version && hermes --version \
 && readlink -f "$(command -v claude)" && readlink -f "$(command -v codex)" && readlink -f "$(command -v opencode)" \
 && readlink -f "$(command -v agy)" && readlink -f "$(command -v omp)" && readlink -f "$(command -v pi-acp)" \
 && readlink -f "$(command -v pi)" && readlink -f "$(command -v hermes)"
