#!/usr/bin/env bash
# Starts headless Chrome with the DevTools port the bench driver connects to.
# Usage (loopback, on this host):  chrome.sh <cdp-port> <profile-dir>
# The WAN run starts the same flag set inside the browser container (see wan.sh).
set -euo pipefail

port="${1:?cdp port}"
profile="${2:?profile dir}"

exec google-chrome \
	--headless=new \
	--no-sandbox \
	--remote-debugging-address=127.0.0.1 \
	--remote-debugging-port="$port" \
	--user-data-dir="$profile" \
	--window-size=1920,1080 \
	--force-device-scale-factor=1 \
	${3:+"$3"} \
	--autoplay-policy=no-user-gesture-required \
	--disable-background-timer-throttling \
	--disable-backgrounding-occluded-windows \
	--disable-renderer-backgrounding \
	--disable-features=WebRtcHideLocalIpsWithMdns \
	about:blank
