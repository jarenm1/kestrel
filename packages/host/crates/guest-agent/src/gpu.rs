//! GPU hot-plug on the guest side: load the NVIDIA driver when a device appears, unload it before the host unplugs.

use std::path::Path;
use std::time::Duration;

use crate::system::{log, wait_for_path, Res, System};

/// Load order. `nvidia_modeset` is a dependency of `nvidia_drm`, so it must be listed (and so unloaded) too; `nvidia`
/// cannot unload while it is in use.
const DRIVER_MODULES: [&str; 4] = ["nvidia", "nvidia_uvm", "nvidia_modeset", "nvidia_drm"];
const DEVICE_WAIT: Duration = Duration::from_secs(30);

/// Load the driver and wait for `/dev/nvidia0` to be usable.
pub async fn attach(sys: &System, pci_address: &str) -> Res<()> {
    log(format!("attaching GPU at {pci_address}"));
    for module in DRIVER_MODULES {
        sys.run("modprobe", &[module]).await?;
    }
    // Creates the device nodes (`/dev/nvidia*`) when udev has not; failure only means the nodes already exist.
    if let Err(e) = sys.run("nvidia-modprobe", &["-c", "0", "-u"]).await {
        log(format!("nvidia-modprobe: {e}"));
    }
    if !sys.dry_run {
        wait_for_path(Path::new("/dev/nvidia0"), DEVICE_WAIT).await?;
    }
    Ok(())
}

/// Unload the driver, last module first. Modules that are not loaded are skipped.
pub async fn detach(sys: &System) -> Res<()> {
    for module in DRIVER_MODULES.iter().rev() {
        let loaded = sys.dry_run || Path::new("/sys/module").join(module).exists();
        if loaded {
            sys.run("rmmod", &[module]).await?;
        }
    }
    Ok(())
}
