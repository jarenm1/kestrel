# Installs kestrel-box inside WSL2. Requires a distro with systemd enabled.
# Usage: install-box.ps1 [-NoLogin] [-NoInstall]
param(
  [switch]$NoLogin,
  [switch]$NoInstall
)

$ErrorActionPreference = "Stop"
$installerUrl = if ($env:KESTREL_BOX_INSTALLER_URL) {
  $env:KESTREL_BOX_INSTALLER_URL
} else {
  "https://raw.githubusercontent.com/jarenm1/kestrel/main/scripts/install-box.sh"
}

if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) {
  Write-Error "WSL is required: run 'wsl --install -d Ubuntu' in an administrator PowerShell, reboot, then run this again"
}

$distros = (wsl -l -q) -replace "`0", "" | Where-Object { $_.Trim() -ne "" }
if (-not $distros) {
  Write-Error "no WSL distro is installed: run 'wsl --install -d Ubuntu'"
}

$init = (wsl -e sh -lc "cat /proc/1/comm" | Out-String).Trim()
if ($init -ne "systemd") {
  Write-Error "WSL must run systemd: add '[boot] systemd=true' to /etc/wsl.conf inside the distro, run 'wsl --shutdown', then try again"
}

$flags = @()
if ($NoLogin) { $flags += "--no-login" }
if ($NoInstall) { $flags += "--no-install" }
wsl -e sh -lc "curl -fsSL '$installerUrl' | sh -s -- $($flags -join ' ')"
exit $LASTEXITCODE
