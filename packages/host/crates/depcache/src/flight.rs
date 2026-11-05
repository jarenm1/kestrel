use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

/// Per-key async locks: concurrent requests for one metadata document or artifact wait for a single upstream fetch.
#[derive(Default)]
pub struct Flights {
    keys: Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
}

impl Flights {
    /// Waits until no other task holds `key`. Dropping the guard releases it.
    pub async fn lock(&self, key: &str) -> OwnedMutexGuard<()> {
        let flight = {
            let mut keys = self.keys.lock().expect("flight map lock");
            keys.retain(|_, flight| flight.strong_count() > 0);
            match keys.get(key).and_then(Weak::upgrade) {
                Some(flight) => flight,
                None => {
                    let flight = Arc::new(AsyncMutex::new(()));
                    keys.insert(key.to_owned(), Arc::downgrade(&flight));
                    flight
                }
            }
        };
        flight.lock_owned().await
    }
}
