#!/usr/bin/env bash
# WAN condition for the desktop bench. The browser and the bench driver run in a container on a dedicated bridge
# (kbench0, 172.31.0.0/24). netem shapes both directions of that link: container eth0 egress (container -> host) and
# bridge kbench0 egress (host -> container). Each hop is `delay 20ms 10ms`, so RTT is about 40 ms with 10 ms jitter
# per hop. Loss X% applies on each hop, so each direction loses about X%.
# The stacks stay on host loopback; proxy.ts binds the bridge gateway (172.31.0.1) and forwards to 127.0.0.1.
#
# Host firewall: NixOS drops input on kbench0 (only lo/tailscale0 are trusted). `up` inserts ACCEPT rules at the top of
# nixos-fw, scoped to the worker IP on kbench0 only: TCP to each proxied port, and UDP for WebRTC ICE. `down` removes
# exactly the rules `up` added (ports are recorded in $STATE/ports).
#
# Usage:
#   wan.sh up <loss-percent> <port>...     create network, start worker container + Chrome, proxies, netem, firewall
#   wan.sh set-loss <loss-percent>         re-apply netem with a new loss value
#   wan.sh bench <bench.ts args...>        run the bench driver inside the worker container
#   wan.sh down                            remove netem, firewall rules, proxies, container, network
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
NET=kbench-wan
BR=kbench0
SUBNET=172.31.0.0/24
GW=172.31.0.1
WORKER_IP=172.31.0.40
NAME=kbench-worker
STATE=/tmp/kbench-wan
# Tools come from the nix store (mounted read-only into containers). Resolve from the host PATH.
TC="$(readlink -f "$(command -v tc)")"
BUN="$(readlink -f "$(command -v bun)")"
IPT="$(readlink -f "$(command -v iptables)")"
CHROME_BIN_DIR="$(dirname "$(readlink -f "$(command -v google-chrome)")")"
IMAGE=ubuntu:24.04

netem_args() {
	local loss="$1"
	local args="delay 20ms 10ms"
	if [ "$loss" != "0" ]; then args="$args loss ${loss}%"; fi
	printf '%s' "$args"
}

apply_netem() {
	local loss="$1"
	local args
	args="$(netem_args "$loss")"
	# The worker runs as uid 1000, which has no effective capabilities, so tc runs as root in the container.
	# shellcheck disable=SC2086
	docker exec --user root "$NAME" "$TC" qdisc replace dev eth0 root netem $args
	# shellcheck disable=SC2086
	docker run --rm --net=host --cap-add NET_ADMIN -v /nix/store:/nix/store:ro "$IMAGE" \
		"$TC" qdisc replace dev "$BR" root netem $args
	echo "netem applied: $args (container eth0 + $BR)"
}

# Runs iptables as root from a helper container on the host network (the host has no root for this user).
host_iptables() {
	docker run --rm --net=host --cap-add NET_ADMIN -v /nix/store:/nix/store:ro "$IMAGE" "$IPT" iptables "$@"
}

firewall_open() {
	local p
	for p in "$@"; do
		host_iptables -I nixos-fw 1 -i "$BR" -s "$WORKER_IP" -p tcp --dport "$p" -j ACCEPT
	done
	host_iptables -I nixos-fw 1 -i "$BR" -s "$WORKER_IP" -p udp -j ACCEPT
	echo "firewall: accept from $WORKER_IP on $BR (tcp $*, udp)"
}

firewall_close() {
	[ -f "$STATE/ports" ] || return 0
	local p
	for p in $(cat "$STATE/ports"); do
		host_iptables -D nixos-fw -i "$BR" -s "$WORKER_IP" -p tcp --dport "$p" -j ACCEPT >/dev/null 2>&1 || true
	done
	host_iptables -D nixos-fw -i "$BR" -s "$WORKER_IP" -p udp -j ACCEPT >/dev/null 2>&1 || true
	echo "firewall: rules removed"
}

cmd_up() {
	local loss="$1"
	shift
	mkdir -p "$STATE"
	# Clear rules from an earlier up before adding new ones.
	firewall_close
	printf '%s\n' "$@" >"$STATE/ports"
	if ! docker network inspect "$NET" >/dev/null 2>&1; then
		docker network create --driver bridge --subnet "$SUBNET" --gateway "$GW" \
			-o com.docker.network.bridge.name="$BR" "$NET" >/dev/null
	fi
	docker rm -f "$NAME" >/dev/null 2>&1 || true
	docker run -d --name "$NAME" --network "$NET" --ip "$WORKER_IP" --pid=host \
		--cap-add NET_ADMIN --cap-add SYS_PTRACE --shm-size=1g --user 1000:1000 -e HOME=/tmp \
		-v /nix/store:/nix/store:ro -v "$REPO_ROOT:$REPO_ROOT" \
		"$IMAGE" sleep infinity >/dev/null
	apply_netem "$loss"
	firewall_open "$@"
	for p in "$@"; do
		setsid nohup "$BUN" "$HERE/proxy.ts" --listen "$GW:$p" --to "127.0.0.1:$p" \
			>"$STATE/proxy-$p.log" 2>&1 </dev/null &
		echo $! >"$STATE/proxy-$p.pid"
	done
	# The app calls the box at its own 127.0.0.1:<port> (control and box ports), so each port also gets an in-container
	# relay to the gateway proxy. Chrome and the bench driver run in this container, so loopback is the container's.
	for p in "$@"; do
		docker exec -d "$NAME" "$BUN" "$HERE/proxy.ts" --listen "127.0.0.1:$p" --to "$GW:$p"
	done
	# Chrome inside the container, same flags as chrome.sh (CDP on 9333 inside the container). The proxied origins are
	# plain http on an IP, so Chrome would drop the Secure session cookie; treat them as secure origins (WAN only).
	local origins="" p
	for p in "$@"; do origins="${origins:+$origins,}http://$GW:$p"; done
	docker exec -d -e PATH="$CHROME_BIN_DIR:/usr/bin:/bin" "$NAME" \
		"$REPO_ROOT/packages/server/scripts/desktop-bench/chrome.sh" 9333 /tmp/kbench-chrome "--unsafely-treat-insecure-origin-as-secure=$origins"
	echo "up: worker $WORKER_IP, proxies on $GW for ports: $*"
}

cmd_set_loss() {
	apply_netem "$1"
}

cmd_bench() {
	# Root with SYS_PTRACE (uid 1000 has no effective caps): readlink /proc/<box>/cwd is needed for CPU sampling.
	docker exec -u 0 -w "$REPO_ROOT/packages/server" "$NAME" "$BUN" run scripts/desktop-bench/bench.ts "$@"
	docker exec --user root "$NAME" chown -R 1000:1000 "$REPO_ROOT/packages/server/scripts/desktop-bench/results"
}

cmd_down() {
	docker exec --user root "$NAME" "$TC" qdisc del dev eth0 root >/dev/null 2>&1 || true
	docker run --rm --net=host --cap-add NET_ADMIN -v /nix/store:/nix/store:ro "$IMAGE" \
		"$TC" qdisc del dev "$BR" root >/dev/null 2>&1 || true
	firewall_close
	if [ -d "$STATE" ]; then
		for f in "$STATE"/proxy-*.pid; do
			[ -f "$f" ] || continue
			kill "$(cat "$f")" >/dev/null 2>&1 || true
			rm -f "$f"
		done
	fi
	docker rm -f "$NAME" >/dev/null 2>&1 || true
	docker network rm "$NET" >/dev/null 2>&1 || true
	echo "down: done"
}

case "${1:-}" in
	up) shift; cmd_up "$@" ;;
	set-loss) shift; cmd_set_loss "$@" ;;
	bench) shift; cmd_bench "$@" ;;
	down) cmd_down ;;
	*) echo "usage: wan.sh up <loss> <port>... | set-loss <loss> | bench <args> | down" >&2; exit 2 ;;
esac
