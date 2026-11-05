//! Wire frames of `packages/protocol/src/guest.ts`. Every frame is one JSON object per line with a `_tag`.
//! Field names are camelCase on the wire; the `_tag` values are the Effect schema literals.

use serde::{Deserialize, Serialize};

/// `GUEST_PROTOCOL` in guest.ts; sent in `hello`.
pub const GUEST_PROTOCOL: u32 = 1;
/// `GUEST_AGENT_VSOCK_PORT` in guest.ts.
pub const GUEST_AGENT_VSOCK_PORT: u32 = 1024;
/// `GUEST_AGENT_BOX_SOCKET` in guest.ts.
pub const GUEST_AGENT_BOX_SOCKET: &str = "/run/kestrel-guest/box.sock";
/// `NEST_BOX_USER` in guest.ts: the uid the box service runs as; the box socket accepts only this uid.
pub const NEST_BOX_USER: &str = "kestrel-box";
/// `GUEST_STATUS_INTERVAL_MS` in guest.ts.
pub const STATUS_INTERVAL_MS: u64 = 2_000;
/// `MAX_GUEST_FRAME_BYTES` in guest.ts: longest line either side reads; a longer one drops the connection.
pub const MAX_FRAME_BYTES: usize = 64 * 1024;
/// `RequestId` in guest.ts: 1 to 100 characters.
pub const MAX_ID_LEN: usize = 100;
/// `GUEST_ERROR_MAX_CHARS` in guest.ts: the longest `error` a reply carries; a longer one is cut to this length.
pub const GUEST_ERROR_MAX_CHARS: usize = 1000;
/// `NEST_VOLUME_MOUNT` in guest.ts.
pub const NEST_VOLUME_MOUNT: &str = "/var/lib/kestrel";
/// `NEST_VOLUME_SERIAL` in guest.ts; also the filesystem label the agent formats the volume with.
pub const NEST_VOLUME_SERIAL: &str = "kestrel-volume";
/// `NEST_BOX_ENV` in guest.ts: the variable names the guest agent writes to the box env file, and nothing else.
pub struct BoxEnvNames {
    pub box_id: &'static str,
    pub control_url: &'static str,
    pub public_url: &'static str,
    pub guest_agent_socket: &'static str,
    pub enroll_token: &'static str,
    pub data_dir: &'static str,
}

pub const NEST_BOX_ENV: BoxEnvNames = BoxEnvNames {
    box_id: "CLOUDAGENTS_BOX_ID",
    control_url: "CLOUDAGENTS_CONTROL_URL",
    public_url: "CLOUDAGENTS_BOX_PUBLIC_URL",
    guest_agent_socket: "CLOUDAGENTS_GUEST_AGENT_SOCKET",
    enroll_token: "CLOUDAGENTS_NEST_ENROLL_TOKEN",
    data_dir: "CLOUDAGENTS_DATA_DIR",
};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GuestNetwork {
    /// IPv4 address with prefix, e.g. `10.77.0.5/32`.
    pub address: String,
    pub gateway: String,
    pub ipv6_address: Option<String>,
    pub ipv6_gateway: Option<String>,
    pub dns: Vec<String>,
    pub depcache_url: Option<String>,
    pub nix_cache_url: Option<String>,
    pub nix_cache_public_key: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureArgs {
    pub id: String,
    pub host_id: String,
    pub box_id: String,
    pub vm_id: String,
    pub clone_id: String,
    pub wall_clock_ms: u64,
    pub control_url: String,
    pub public_url: String,
    pub enroll_token: Option<String>,
    pub network: GuestNetwork,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GpuState {
    None,
    Attaching,
    Attached,
    Detaching,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GuestPressure {
    pub mem_total_bytes: u64,
    pub mem_available_bytes: u64,
    pub mem_some_avg10: f64,
    pub mem_full_avg10: f64,
    pub cpu_some_avg10: f64,
    pub online_cpus: u64,
    pub load_avg1: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BoxActivity {
    pub runs: u64,
    pub desktops: u64,
    pub viewers: u64,
    pub recordings: u64,
    pub last_activity_at: Option<u64>,
}

/// `GuestReply`: the answer to a request on either link, with the request's `id`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReplyBody {
    pub id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// Host -> guest agent.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(
    tag = "_tag",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HostToGuest {
    Configure(Box<ConfigureArgs>),
    PrepareSuspend {
        id: String,
    },
    Resumed {
        id: String,
        wall_clock_ms: u64,
    },
    FreezeVolume {
        id: String,
    },
    ThawVolume {
        id: String,
    },
    GpuAttached {
        id: String,
        pci_address: String,
    },
    GpuDetach {
        id: String,
    },
    GpuDecision {
        id: String,
        granted: bool,
        error: Option<String>,
    },
    Ping {
        id: String,
    },
    /// Any other `_tag` is ignored, so either side may add frames without a version bump.
    #[serde(other)]
    Unknown,
}

impl HostToGuest {
    pub fn id(&self) -> Option<&str> {
        match self {
            Self::Configure(args) => Some(&args.id),
            Self::PrepareSuspend { id }
            | Self::Resumed { id, .. }
            | Self::FreezeVolume { id }
            | Self::ThawVolume { id }
            | Self::GpuAttached { id, .. }
            | Self::GpuDetach { id }
            | Self::GpuDecision { id, .. }
            | Self::Ping { id } => Some(id),
            Self::Unknown => None,
        }
    }
}

// Guest agent -> host.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(
    tag = "_tag",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GuestToHost {
    Hello {
        protocol: u32,
        agent_version: String,
        boot_id: String,
        clone_id: Option<String>,
        configured: bool,
    },
    Status {
        pressure: GuestPressure,
        activity: Option<BoxActivity>,
        gpu: GpuState,
    },
    GpuWanted {
        id: String,
        wanted: bool,
    },
    Reply(ReplyBody),
    #[serde(other)]
    Unknown,
}

// Box -> guest agent.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(
    tag = "_tag",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BoxToGuest {
    Hello {
        box_version: String,
    },
    Activity {
        activity: BoxActivity,
    },
    GpuWanted {
        id: String,
        wanted: bool,
    },
    Enrolled,
    Reply(ReplyBody),
    #[serde(other)]
    Unknown,
}

// Guest agent -> box.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(
    tag = "_tag",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GuestToBox {
    Quiesce {
        id: String,
    },
    Resumed {
        id: String,
    },
    GpuState {
        state: GpuState,
        pci_address: Option<String>,
    },
    ReleaseGpu {
        id: String,
    },
    Reply(ReplyBody),
    #[serde(other)]
    Unknown,
}

/// `RequestId` schema: 1 to 100 characters.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().count() <= MAX_ID_LEN
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_tag_is_ignored_not_fatal() {
        let frame: HostToGuest =
            serde_json::from_str(r#"{"_tag":"somethingNew","id":"a"}"#).unwrap();
        assert_eq!(frame, HostToGuest::Unknown);
        assert_eq!(frame.id(), None);
    }

    #[test]
    fn reply_omits_absent_error() {
        let frame = GuestToHost::Reply(ReplyBody {
            id: "r1".into(),
            ok: true,
            error: None,
        });
        assert_eq!(
            serde_json::to_string(&frame).unwrap(),
            r#"{"_tag":"reply","id":"r1","ok":true}"#
        );
    }

    #[test]
    fn request_id_bounds() {
        assert!(!valid_id(""));
        assert!(valid_id(&"x".repeat(100)));
        assert!(!valid_id(&"x".repeat(101)));
    }
}

/// Cross-language contract: `tests/fixtures/guest-frames.json` is written by `tests/fixtures-gen.ts` from the
/// TypeScript schemas. Every frame must decode here and re-encode to the same JSON.
#[cfg(test)]
mod contract_tests {
    use serde::de::DeserializeOwned;
    use serde_json::Value;

    use super::*;

    const FIXTURES: &str = include_str!("../tests/fixtures/guest-frames.json");

    fn assert_round_trip<T: DeserializeOwned + Serialize>(frames: &Value) {
        let frames = frames.as_array().expect("fixture category is an array");
        assert!(!frames.is_empty());
        for frame in frames {
            let decoded: T = serde_json::from_value(frame.clone())
                .unwrap_or_else(|e| panic!("decode {frame}: {e}"));
            assert_eq!(serde_json::to_value(&decoded).expect("encode"), *frame);
        }
    }

    #[test]
    fn every_fixture_frame_round_trips() {
        let fixtures: Value = serde_json::from_str(FIXTURES).expect("fixture file is JSON");
        assert_round_trip::<HostToGuest>(&fixtures["hostToGuest"]);
        assert_round_trip::<GuestToHost>(&fixtures["guestToHost"]);
        assert_round_trip::<BoxToGuest>(&fixtures["boxToGuest"]);
        assert_round_trip::<GuestToBox>(&fixtures["guestToBox"]);
    }

    #[test]
    fn box_user_matches_the_contract() {
        let fixtures: Value = serde_json::from_str(FIXTURES).expect("fixture file is JSON");
        assert_eq!(fixtures["boxUser"], NEST_BOX_USER);
    }
}
