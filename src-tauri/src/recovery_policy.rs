//! Bounded recovery shared by renderer and host supervision.
use std::collections::VecDeque;
use std::time::{Duration, Instant};

pub const MAX_ATTEMPTS: usize = 3;
const WINDOW: Duration = Duration::from_secs(120);

#[derive(Default)]
pub struct RecoveryPolicy {
    attempts: VecDeque<Instant>,
    active: Option<u64>,
    next: u64,
}
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Retry {
        generation: u64,
        delay: Duration,
        attempt: usize,
    },
    Busy,
    Exhausted,
}
impl RecoveryPolicy {
    pub fn begin(&mut self, now: Instant) -> Decision {
        if self.active.is_some() {
            return Decision::Busy;
        }
        while self
            .attempts
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) >= WINDOW)
        {
            self.attempts.pop_front();
        }
        if self.attempts.len() >= MAX_ATTEMPTS {
            return Decision::Exhausted;
        }
        self.attempts.push_back(now);
        self.next += 1;
        self.active = Some(self.next);
        Decision::Retry {
            generation: self.next,
            delay: Duration::from_millis([500, 1500, 4000][self.attempts.len() - 1]),
            attempt: self.attempts.len(),
        }
    }
    pub fn finish(&mut self, generation: u64) -> bool {
        if self.active != Some(generation) {
            return false;
        }
        self.active = None;
        true
    }
    pub fn current(&self) -> Option<u64> {
        self.active
    }
    pub fn manual_retry(&mut self) {
        if self.active.is_none() {
            self.attempts.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_events_share_one_recovery_and_crash_loops_are_bounded() {
        let now = Instant::now();
        let mut policy = RecoveryPolicy::default();
        for attempt in 1..=MAX_ATTEMPTS {
            let Decision::Retry {
                generation,
                attempt: actual,
                ..
            } = policy.begin(now)
            else {
                panic!("missing retry")
            };
            assert_eq!(actual, attempt);
            assert_eq!(policy.begin(now), Decision::Busy);
            assert!(!policy.finish(generation + 1));
            assert!(policy.finish(generation));
        }
        assert_eq!(policy.begin(now), Decision::Exhausted);
        assert!(matches!(
            policy.begin(now + WINDOW),
            Decision::Retry { attempt: 1, .. }
        ));
    }
    #[test]
    fn manual_retry_does_not_interrupt_an_active_recovery() {
        let now = Instant::now();
        let mut policy = RecoveryPolicy::default();
        let Decision::Retry { generation, .. } = policy.begin(now) else {
            panic!()
        };
        policy.manual_retry();
        assert_eq!(policy.begin(now), Decision::Busy);
        policy.finish(generation);
        policy.manual_retry();
        assert!(matches!(
            policy.begin(now),
            Decision::Retry { attempt: 1, .. }
        ));
    }
}
