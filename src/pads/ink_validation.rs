//! Bounded process cache of strict validation results, shared across SQLite connections.
use super::sync_content;
use anyhow::{ensure, Result};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

const MAX_CACHED_PAGES: usize = 4096;
type PageKey = (i64, [u8; 32]);

#[derive(Clone)]
pub(super) struct ValidatedPage {
    pub wire_hash: String,
    pub is_empty: bool,
}

#[derive(Default)]
struct PageCache {
    entries: HashMap<PageKey, ValidatedPage>,
    order: VecDeque<PageKey>,
}

impl PageCache {
    fn insert(&mut self, key: PageKey, value: ValidatedPage) {
        if self.entries.contains_key(&key) {
            return;
        }
        if self.entries.len() == MAX_CACHED_PAGES {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
        self.order.push_back(key);
        self.entries.insert(key, value);
    }
}

#[cfg(test)]
thread_local! {
    static VALIDATION_MISSES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
#[cfg(test)]
pub(super) fn validation_misses() -> usize {
    VALIDATION_MISSES.with(|count| count.get())
}

pub(super) fn validate_page(rev: i64, bytes: &[u8]) -> Result<ValidatedPage> {
    static CACHE: OnceLock<Mutex<PageCache>> = OnceLock::new();
    validate_cached(
        CACHE.get_or_init(|| Mutex::new(PageCache::default())),
        rev,
        bytes,
    )
}

fn validate_cached(cache: &Mutex<PageCache>, rev: i64, bytes: &[u8]) -> Result<ValidatedPage> {
    ensure!(
        bytes.len() <= sync_content::MAX_INK_TRANSFER_BYTES,
        "ink exceeds transfer limit"
    );
    // Revisions are immutable, but also fingerprint the bytes actually read:
    // corruption, external SQL edits and another database reusing a revision
    // cannot inherit an earlier validation. Only hashes/emptiness are retained.
    let key = (rev, Sha256::digest(bytes).into());
    if let Some(value) = cache
        .lock()
        .ok()
        .and_then(|cache| cache.entries.get(&key).cloned())
    {
        return Ok(value);
    }
    #[cfg(test)]
    VALIDATION_MISSES.with(|count| count.set(count.get() + 1));
    // Validate outside the lock so unrelated first reads can run concurrently.
    // Invalid bytes are never cached, and a poisoned cache just disables reuse.
    let checked = sync_content::validate_ink(bytes)?;
    let value = ValidatedPage {
        wire_hash: checked.wire_hash,
        is_empty: checked.is_empty,
    };
    if let Ok(mut cache) = cache.lock() {
        cache.insert(key, value.clone());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_is_bounded_and_revalidates_evicted_revisions() {
        let cache = Mutex::new(PageCache::default());
        let mut bytes = b"inkC".to_vec();
        bytes.extend(1_u32.to_le_bytes());
        bytes.extend(11_u32.to_le_bytes());
        bytes.extend(b"{\"meta\":[]}");
        for rev in 0..=MAX_CACHED_PAGES as i64 {
            assert!(validate_cached(&cache, rev, &bytes).unwrap().is_empty);
        }
        assert_eq!(cache.lock().unwrap().entries.len(), MAX_CACHED_PAGES);
        let before = validation_misses();
        validate_cached(&cache, MAX_CACHED_PAGES as i64, &bytes).unwrap();
        assert_eq!(validation_misses(), before);
        validate_cached(&cache, 0, &bytes).unwrap();
        assert_eq!(validation_misses(), before + 1);
    }
}
