use std::fs::{self, Permissions};
use std::io::{Seek, SeekFrom, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use tempfile::TempDir;

const CHUNK: u64 = 4 * 1024 * 1024;
const SIZE: u64 = 3 * CHUNK + 512 * 1024;

struct Fixture {
    dir: TempDir,
    store: String,
    key: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let key = dir.path().join("volume.key");
        fs::write(&key, [7u8; 32]).unwrap();
        fs::set_permissions(&key, Permissions::from_mode(0o600)).unwrap();
        let store = format!("file://{}", dir.path().join("store").display());
        Self { dir, store, key }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_kestrel-volume"))
            .args(args)
            .output()
            .unwrap()
    }

    fn json(&self, args: &[&str]) -> serde_json::Value {
        let out = self.run(args);
        assert!(
            out.status.success(),
            "{args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice(&out.stdout).unwrap()
    }

    fn backup(&self, volume: &Path) -> serde_json::Value {
        fs::create_dir_all(self.path("state")).unwrap();
        self.json(&[
            "backup",
            "--path",
            volume.to_str().unwrap(),
            "--state-dir",
            self.path("state").to_str().unwrap(),
            "--box",
            "box-1",
            "--store",
            &self.store,
            "--key-file",
            self.key.to_str().unwrap(),
        ])
    }

    fn restore(&self, volume_ref: &str, dest: &Path, key: &Path) -> Output {
        self.run(&[
            "restore",
            "--ref",
            volume_ref,
            "--dest",
            dest.to_str().unwrap(),
            "--box",
            "box-1",
            "--store",
            &self.store,
            "--key-file",
            key.to_str().unwrap(),
        ])
    }

    fn create(&self, name: &str) -> PathBuf {
        let path = self.path(name);
        self.json(&[
            "create",
            "--path",
            path.to_str().unwrap(),
            "--size-bytes",
            &SIZE.to_string(),
        ]);
        path
    }
}

fn fill(path: &Path, offset: u64, byte: u8, len: usize) {
    let mut file = fs::OpenOptions::new().write(true).open(path).unwrap();
    file.seek(SeekFrom::Start(offset)).unwrap();
    file.write_all(&vec![byte; len]).unwrap();
    file.sync_all().unwrap();
}

#[test]
fn backup_then_restore_reproduces_the_volume_and_reuploads_only_changes() {
    let fx = Fixture::new();
    let volume = fx.create("volume.raw");
    fill(&volume, 0, 0xA1, CHUNK as usize);
    fill(&volume, CHUNK, 0xB2, CHUNK as usize);
    fill(&volume, 2 * CHUNK, 0xC3, CHUNK as usize);
    fill(&volume, 3 * CHUNK, 0xD4, 512 * 1024);

    let first = fx.backup(&volume);
    assert_eq!(first["chunks"], 4);
    let first_bytes = first["bytesUploaded"].as_u64().unwrap();
    let volume_ref = first["volumeRef"].as_str().unwrap().to_owned();

    let restored = fx.path("restored.raw");
    let out = fx.json(&[
        "restore",
        "--ref",
        &volume_ref,
        "--dest",
        restored.to_str().unwrap(),
        "--box",
        "box-1",
        "--store",
        &fx.store,
        "--key-file",
        fx.key.to_str().unwrap(),
    ]);
    assert_eq!(out["bytes"], SIZE);
    assert_eq!(fs::read(&volume).unwrap(), fs::read(&restored).unwrap());

    fill(&volume, CHUNK + 4096, 0xE5, 4096);
    let second = fx.backup(&volume);
    assert_eq!(second["chunks"], 1);
    let second_bytes = second["bytesUploaded"].as_u64().unwrap();
    assert!(second_bytes > 0 && second_bytes < first_bytes);
    assert_ne!(second["volumeRef"], first["volumeRef"]);
}

#[test]
fn backup_accepts_a_relative_volume_path() {
    let fx = Fixture::new();
    let volume = fx.create("volume.raw");
    fill(&volume, 0, 0x5A, 4096);
    fs::create_dir(fx.path("state")).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_kestrel-volume"))
        .current_dir(fx.dir.path())
        .args([
            "backup",
            "--path",
            "volume.raw",
            "--state-dir",
            "state",
            "--box",
            "box-1",
            "--store",
            &fx.store,
            "--key-file",
            fx.key.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(fx.path("state/box-1.base.ref").is_file());
}

#[test]
fn restore_with_a_different_key_fails_and_leaves_no_file() {
    let fx = Fixture::new();
    let volume = fx.create("volume.raw");
    fill(&volume, 0, 0x11, 4096);
    let volume_ref = fx.backup(&volume)["volumeRef"].as_str().unwrap().to_owned();

    let other_key = fx.path("other.key");
    fs::write(&other_key, [9u8; 32]).unwrap();
    fs::set_permissions(&other_key, Permissions::from_mode(0o600)).unwrap();

    let dest = fx.path("restored.raw");
    let out = fx.restore(&volume_ref, &dest, &other_key);
    assert!(!out.status.success());
    assert!(!dest.exists());
}

#[test]
fn key_file_readable_by_others_is_refused() {
    let fx = Fixture::new();
    let volume = fx.create("volume.raw");
    fs::set_permissions(&fx.key, Permissions::from_mode(0o644)).unwrap();
    let out = fx.run(&[
        "backup",
        "--path",
        volume.to_str().unwrap(),
        "--box",
        "box-1",
        "--store",
        &fx.store,
        "--key-file",
        fx.key.to_str().unwrap(),
    ]);
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
}

#[test]
fn create_rejects_sizes_that_are_not_whole_sectors() {
    let fx = Fixture::new();
    let path = fx.path("odd.raw");
    let out = fx.run(&[
        "create",
        "--path",
        path.to_str().unwrap(),
        "--size-bytes",
        "1000",
    ]);
    assert!(!out.status.success());
    assert!(!path.exists());
}

#[test]
fn delete_removes_the_box_from_the_store() {
    let fx = Fixture::new();
    let volume = fx.create("volume.raw");
    fill(&volume, 0, 0x33, 4096);
    let volume_ref = fx.backup(&volume)["volumeRef"].as_str().unwrap().to_owned();

    let out = fx.json(&["delete", "--box", "box-1", "--store", &fx.store]);
    assert!(out["deleted"].as_u64().unwrap() > 0);

    let dest = fx.path("restored.raw");
    let out = fx.restore(&volume_ref, &dest, &fx.key);
    assert!(!out.status.success());
    assert!(!dest.exists());
}
