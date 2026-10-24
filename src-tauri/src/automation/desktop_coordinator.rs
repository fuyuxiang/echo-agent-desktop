//! One physical desktop shared by all sessions. Never held for user approval.
//! Owned guards can travel with native work when its HTTP caller is dropped.
use std::sync::{Arc, OnceLock};
use tokio::sync::{Mutex, OwnedMutexGuard};
use tokio_util::sync::CancellationToken;
fn desktop() -> &'static Arc<Mutex<()>> {
    static DESKTOP: OnceLock<Arc<Mutex<()>>> = OnceLock::new();
    DESKTOP.get_or_init(|| Arc::new(Mutex::new(())))
}
pub async fn acquire(token: &CancellationToken) -> Result<OwnedMutexGuard<()>, String> {
    tokio::select! {
        biased;
        _ = token.cancelled() => Err("cancelled: desktop queue cancelled; no input dispatched".into()),
        guard = desktop().clone().lock_owned() => Ok(guard),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn competing_session_can_cancel_without_stealing_desktop() {
        let a = CancellationToken::new();
        let owner = acquire(&a).await.unwrap();
        let b = CancellationToken::new();
        b.cancel();
        assert!(acquire(&b).await.is_err());
        assert!(desktop().try_lock().is_err());
        drop(owner);
        assert!(acquire(&a).await.is_ok());
    }
}
