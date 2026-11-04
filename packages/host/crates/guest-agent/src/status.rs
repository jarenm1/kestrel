//! Memory and CPU pressure, read from procfs/sysfs on every status tick. Parsers are pure so they can be tested.

use std::fs;

use crate::protocol::GuestPressure;
use crate::system::Res;

pub fn read_pressure() -> Res<GuestPressure> {
    let meminfo = read("/proc/meminfo")?;
    let mem_psi = read("/proc/pressure/memory")?;
    let cpu_psi = read("/proc/pressure/cpu")?;
    let loadavg = read("/proc/loadavg")?;
    let online = read("/sys/devices/system/cpu/online")?;
    Ok(GuestPressure {
        mem_total_bytes: meminfo_bytes(&meminfo, "MemTotal:")?,
        mem_available_bytes: meminfo_bytes(&meminfo, "MemAvailable:")?,
        mem_some_avg10: psi_avg10(&mem_psi, "some")?,
        mem_full_avg10: psi_avg10(&mem_psi, "full")?,
        cpu_some_avg10: psi_avg10(&cpu_psi, "some")?,
        online_cpus: count_cpu_list(&online)?,
        load_avg1: loadavg
            .split_whitespace()
            .next()
            .ok_or("empty /proc/loadavg")?
            .parse::<f64>()
            .map_err(|e| format!("loadavg: {e}"))?,
    })
}

fn read(path: &str) -> Res<String> {
    fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))
}

/// `MemTotal:  16314032 kB` -> bytes.
pub fn meminfo_bytes(text: &str, key: &str) -> Res<u64> {
    let line = text
        .lines()
        .find(|l| l.starts_with(key))
        .ok_or_else(|| format!("{key} missing from meminfo"))?;
    let kb: u64 = line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| format!("{key} has no value"))?
        .parse()
        .map_err(|e| format!("{key}: {e}"))?;
    Ok(kb * 1024)
}

/// `some avg10=0.12 avg60=...` line of a PSI file -> avg10, clamped to the 0..=100 range the contract allows.
pub fn psi_avg10(text: &str, kind: &str) -> Res<f64> {
    let line = text
        .lines()
        .find(|l| l.split_whitespace().next() == Some(kind))
        .ok_or_else(|| format!("no {kind} line in pressure file"))?;
    let value = line
        .split_whitespace()
        .find_map(|f| f.strip_prefix("avg10="))
        .ok_or_else(|| format!("no avg10 in {line:?}"))?;
    let v: f64 = value.parse().map_err(|e| format!("avg10 {value:?}: {e}"))?;
    Ok(v.clamp(0.0, 100.0))
}

/// `0-3,5,7-8` -> 7.
pub fn count_cpu_list(text: &str) -> Res<u64> {
    let mut total = 0u64;
    for part in text.trim().split(',').filter(|p| !p.is_empty()) {
        let (lo, hi) = match part.split_once('-') {
            Some((a, b)) => (a, b),
            None => (part, part),
        };
        let lo: u64 = lo.parse().map_err(|e| format!("cpu list {part:?}: {e}"))?;
        let hi: u64 = hi.parse().map_err(|e| format!("cpu list {part:?}: {e}"))?;
        if hi < lo {
            return Err(format!("cpu list {part:?} is reversed"));
        }
        total += hi - lo + 1;
    }
    if total == 0 {
        return Err("no online cpus".into());
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_meminfo_in_bytes() {
        let text = "MemTotal:       16314032 kB\nMemAvailable:    9000000 kB\n";
        assert_eq!(meminfo_bytes(text, "MemTotal:").unwrap(), 16_314_032 * 1024);
        assert_eq!(
            meminfo_bytes(text, "MemAvailable:").unwrap(),
            9_000_000 * 1024
        );
        assert!(meminfo_bytes(text, "Cached:").is_err());
    }

    #[test]
    fn parses_psi_avg10_and_clamps() {
        let text = "some avg10=1.25 avg60=0.10 avg300=0.00 total=5\nfull avg10=250.0 avg60=0 avg300=0 total=0\n";
        assert_eq!(psi_avg10(text, "some").unwrap(), 1.25);
        assert_eq!(psi_avg10(text, "full").unwrap(), 100.0);
        assert!(psi_avg10("some avg60=1", "some").is_err());
    }

    #[test]
    fn counts_online_cpus_from_ranges() {
        assert_eq!(count_cpu_list("0-3,5,7-8\n").unwrap(), 7);
        assert_eq!(count_cpu_list("0").unwrap(), 1);
        assert!(count_cpu_list("3-1").is_err());
    }
}
