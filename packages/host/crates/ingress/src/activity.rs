//! Per-box open connections and last request time, reported to the host agent every few seconds so it can suspend
//! idle boxes and keep busy ones awake.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::api::{ActivityEntry, HostApi};
use crate::route::API_TIMEOUT;

const REPORT_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Default)]
pub struct Tracker {
    boxes: Mutex<HashMap<String, BoxActivity>>,
}

#[derive(Default)]
struct BoxActivity {
    open: usize,
    last_request_at: u64,
    /// What the host was last told: (open connections, last request time).
    reported: Option<(usize, u64)>,
}

impl Tracker {
    /// Counts a request now proxied to `box_id`. The count drops when the guard does.
    pub fn request_started(self: &Arc<Self>, box_id: &str) -> ActivityGuard {
        let mut boxes = self.lock();
        let entry = boxes.entry(box_id.to_owned()).or_default();
        entry.open += 1;
        entry.last_request_at = now_ms();
        ActivityGuard {
            tracker: Arc::clone(self),
            box_id: box_id.to_owned(),
        }
    }

    fn request_finished(&self, box_id: &str) {
        if let Some(entry) = self.lock().get_mut(box_id) {
            entry.open = entry.open.saturating_sub(1);
            entry.last_request_at = now_ms();
        }
    }

    /// Boxes with connections open now, and boxes whose numbers changed since the host was last told.
    fn due(&self) -> Vec<ActivityEntry> {
        self.lock()
            .iter()
            .filter(|(_, entry)| {
                entry.open > 0 || entry.reported != Some((entry.open, entry.last_request_at))
            })
            .map(|(box_id, entry)| ActivityEntry {
                box_id: box_id.clone(),
                open_connections: entry.open,
                last_request_at: entry.last_request_at,
            })
            .collect()
    }

    /// Records what the host now knows. An idle box whose numbers the host has is forgotten.
    fn mark_reported(&self, reported: &[ActivityEntry]) {
        let mut boxes = self.lock();
        for report in reported {
            let Some(entry) = boxes.get_mut(&report.box_id) else {
                continue;
            };
            entry.reported = Some((report.open_connections, report.last_request_at));
            let forget = entry.open == 0 && entry.reported == Some((0, entry.last_request_at));
            if forget {
                boxes.remove(&report.box_id);
            }
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, BoxActivity>> {
        self.boxes.lock().unwrap()
    }

    /// Open connections the tracker holds for a box.
    #[cfg(test)]
    pub fn open_connections(&self, box_id: &str) -> usize {
        self.lock().get(box_id).map_or(0, |entry| entry.open)
    }

    /// Boxes the tracker holds at all.
    #[cfg(test)]
    pub fn tracked(&self) -> usize {
        self.lock().len()
    }
}

/// Held for the life of one proxied request; dropping it releases the box's connection count.
pub struct ActivityGuard {
    tracker: Arc<Tracker>,
    box_id: String,
}

impl Drop for ActivityGuard {
    fn drop(&mut self) {
        self.tracker.request_finished(&self.box_id);
    }
}

/// Posts changed activity to the host agent every `REPORT_INTERVAL`, and nothing when nothing changed.
pub async fn report_loop(tracker: Arc<Tracker>, api: Arc<HostApi>) {
    let mut ticker = tokio::time::interval(REPORT_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let entries = tracker.due();
        if entries.is_empty() {
            continue;
        }
        match tokio::time::timeout(API_TIMEOUT, api.report_activity(&entries)).await {
            Ok(Ok(())) => tracker.mark_reported(&entries),
            Ok(Err(e)) => eprintln!("kestrel-ingress: activity report: {e}"),
            Err(_) => eprintln!("kestrel-ingress: activity report timed out"),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}
