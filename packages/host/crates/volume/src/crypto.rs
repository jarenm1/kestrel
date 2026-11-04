//! Volume encryption: the host fleet key, per-box subkeys derived from it, content-keyed chunk names, and sealed objects.
//!
//! Every object (chunk or manifest) is `nonce (12) || AES-256-GCM(plaintext)` under the box's seal key, with the object's
//! store key as associated data, so an object cannot be moved under another key and still open. A chunk's name is
//! `HMAC-SHA256(name key, plaintext)`, so it reveals nothing about the content, and a decrypted chunk must hash back to
//! the name it was fetched under. The name key and the seal key are separate HKDF outputs.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{Context, Result, bail, ensure};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;

const NONCE_LEN: usize = 12;

pub struct FleetKey([u8; 32]);

impl FleetKey {
    /// Reads the fleet key: 32 raw bytes or 64 hex characters, in a file readable by its owner only.
    pub fn load(path: &Path) -> Result<Self> {
        let meta =
            fs::metadata(path).with_context(|| format!("reading key file {}", path.display()))?;
        ensure!(
            meta.permissions().mode() & 0o077 == 0,
            "key file {} must not be accessible by group or others",
            path.display()
        );
        let raw = fs::read(path).with_context(|| format!("reading key file {}", path.display()))?;
        let bytes = if raw.len() == 32 {
            raw
        } else {
            let text =
                std::str::from_utf8(&raw).context("key file is neither 32 raw bytes nor hex")?;
            hex::decode(text.trim())
                .context("key file is neither 32 raw bytes nor 64 hex characters")?
        };
        let key: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("key file must hold exactly 32 bytes"))?;
        Ok(Self(key))
    }

    /// Per-box subkeys: `HKDF-SHA256(fleet key, "kestrel-volume/name/<boxId>")` names chunks and
    /// `HKDF-SHA256(fleet key, "kestrel-volume/seal/<boxId>")` seals objects.
    pub fn box_key(&self, box_id: &str) -> BoxKey {
        let hk = Hkdf::<Sha256>::new(None, &self.0);
        BoxKey {
            name: expand(&hk, &format!("kestrel-volume/name/{box_id}")),
            seal: expand(&hk, &format!("kestrel-volume/seal/{box_id}")),
        }
    }
}

fn expand(hk: &Hkdf<Sha256>, info: &str) -> [u8; 32] {
    let mut okm = [0u8; 32];
    hk.expand(info.as_bytes(), &mut okm)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    okm
}

pub struct BoxKey {
    name: [u8; 32],
    seal: [u8; 32],
}

impl BoxKey {
    /// Content-keyed chunk name: `hex(HMAC-SHA256(name key, plaintext))`.
    pub fn chunk_name(&self, plaintext: &[u8]) -> String {
        let mut mac =
            Hmac::<Sha256>::new_from_slice(&self.name).expect("HMAC takes any key length");
        mac.update(plaintext);
        hex::encode(mac.finalize().into_bytes())
    }

    /// Encrypts `plaintext` for the object stored under `aad`.
    pub fn seal(&self, aad: &str, plaintext: &[u8]) -> Result<Vec<u8>> {
        let mut nonce = [0u8; NONCE_LEN];
        getrandom::fill(&mut nonce).map_err(|e| anyhow::anyhow!("random nonce: {e}"))?;
        let cipher = Aes256Gcm::new_from_slice(&self.seal).expect("32-byte key");
        let nonce_ref = Nonce::try_from(&nonce[..]).expect("12-byte nonce");
        let ciphertext = cipher
            .encrypt(
                &nonce_ref,
                Payload {
                    msg: plaintext,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| anyhow::anyhow!("sealing {aad} failed"))?;
        let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ciphertext);
        Ok(out)
    }

    /// Decrypts the object stored under `aad`. Fails unless it was sealed under this box's key for that same `aad`.
    pub fn open(&self, aad: &str, sealed: &[u8]) -> Result<Vec<u8>> {
        if sealed.len() < NONCE_LEN {
            bail!("object {aad} is truncated");
        }
        let (nonce, ciphertext) = sealed.split_at(NONCE_LEN);
        let cipher = Aes256Gcm::new_from_slice(&self.seal).expect("32-byte key");
        let nonce_ref = Nonce::try_from(nonce).expect("12-byte nonce");
        cipher
            .decrypt(
                &nonce_ref,
                Payload {
                    msg: ciphertext,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| anyhow::anyhow!("object {aad} failed authentication"))
    }

    /// Decrypts the chunk stored under `name` and checks that the plaintext hashes back to `name`.
    pub fn open_chunk(&self, name: &str, sealed: &[u8]) -> Result<Vec<u8>> {
        let plaintext = self.open(name, sealed)?;
        ensure!(
            self.chunk_name(&plaintext) == name,
            "chunk {name} does not match its content"
        );
        Ok(plaintext)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fleet(byte: u8) -> FleetKey {
        FleetKey([byte; 32])
    }

    #[test]
    fn seal_then_open_round_trips() {
        let key = fleet(7).box_key("box-a");
        let data = vec![42u8; 4096];
        let name = key.chunk_name(&data);
        let sealed = key.seal(&name, &data).unwrap();
        assert_eq!(key.open_chunk(&name, &sealed).unwrap(), data);
    }

    #[test]
    fn other_box_cannot_open_and_names_differ() {
        let a = fleet(7).box_key("box-a");
        let b = fleet(7).box_key("box-b");
        let data = b"same bytes".to_vec();
        assert_ne!(a.chunk_name(&data), b.chunk_name(&data));
        let name = a.chunk_name(&data);
        let sealed = a.seal(&name, &data).unwrap();
        assert!(b.open_chunk(&name, &sealed).is_err());
    }

    #[test]
    fn tampered_or_renamed_chunk_is_rejected() {
        let key = fleet(9).box_key("box-a");
        let data = vec![1u8; 128];
        let name = key.chunk_name(&data);
        let mut sealed = key.seal(&name, &data).unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 1;
        assert!(key.open_chunk(&name, &sealed).is_err());

        let other = vec![2u8; 128];
        let other_name = key.chunk_name(&other);
        let sealed = key.seal(&name, &data).unwrap();
        assert!(key.open_chunk(&other_name, &sealed).is_err());
    }

    #[test]
    fn key_file_must_be_private_and_well_formed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("volume.key");
        fs::write(&path, hex::encode([3u8; 32])).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(FleetKey::load(&path).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(FleetKey::load(&path).is_ok());
        fs::write(&path, [9u8; 31]).unwrap();
        assert!(FleetKey::load(&path).is_err());
    }
}
