# Mimics a WSL/Ubuntu user box: non-Nix Ubuntu 24.04, a non-root user, agent CLIs installed under $HOME.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap git curl ca-certificates nodejs npm \
 && rm -rf /var/lib/apt/lists/*

RUN (userdel -r ubuntu 2>/dev/null || true) \
 && useradd -m -s /bin/bash -u 1000 dev

USER dev
ENV HOME=/home/dev
ENV PATH=/home/dev/.local/bin:/home/dev/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /home/dev

# Claude Code: native installer -> ~/.local/bin/claude -> ~/.local/share/claude/versions/<v>
RUN curl -fsSL https://claude.ai/install.sh | bash

# Codex: npm global under $HOME
RUN npm i -g @openai/codex --prefix /home/dev/.npm-global

RUN claude --version && codex --version && readlink -f "$(command -v claude)" && readlink -f "$(command -v codex)"
