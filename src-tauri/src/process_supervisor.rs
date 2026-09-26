//! Owned process trees. Every spawn gets a group (Unix) or a Job (Windows).
use std::{
    io,
    process::ExitStatus,
    time::{Duration, Instant},
};

pub type AsyncChild = Box<dyn process_wrap::tokio::ChildWrapper>;
pub struct SyncChild(Box<dyn process_wrap::std::ChildWrapper>);
impl std::ops::Deref for SyncChild {
    type Target = dyn process_wrap::std::ChildWrapper;
    fn deref(&self) -> &Self::Target {
        &*self.0
    }
}
impl std::ops::DerefMut for SyncChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut *self.0
    }
}
impl Drop for SyncChild {
    fn drop(&mut self) {
        let _ = self.0.start_kill();
        let _ = self.0.try_wait();
    }
}
const GRACE: Duration = Duration::from_millis(500);
const REAP: Duration = Duration::from_secs(2);

pub fn spawn_async(command: tokio::process::Command) -> io::Result<AsyncChild> {
    use process_wrap::tokio::*;
    let mut wrapped = CommandWrap::from(command);
    #[cfg(unix)]
    wrapped.wrap(ProcessGroup::leader());
    #[cfg(windows)]
    {
        let mut flags = CreationFlags(Default::default());
        flags.0 .0 = 0x08000000; // CREATE_NO_WINDOW; JobObject adds CREATE_SUSPENDED.
        wrapped.wrap(flags).wrap(JobObject);
    }
    wrapped.wrap(KillOnDrop).spawn()
}

pub fn spawn_sync(command: std::process::Command) -> io::Result<SyncChild> {
    use process_wrap::std::*;
    let mut wrapped = CommandWrap::from(command);
    #[cfg(unix)]
    wrapped.wrap(ProcessGroup::leader());
    #[cfg(windows)]
    {
        let mut flags = CreationFlags(Default::default());
        flags.0 .0 = 0x08000000;
        wrapped.wrap(flags).wrap(JobObject);
    }
    wrapped.spawn().map(SyncChild)
}

pub async fn stop_async(child: &mut AsyncChild) -> Option<ExitStatus> {
    #[cfg(unix)]
    let _ = child.signal(libc::SIGTERM);
    #[cfg(windows)]
    let _ = child.start_kill();
    let status = tokio::time::timeout(GRACE, child.wait())
        .await
        .ok()
        .and_then(Result::ok);
    // The shell may have exited while descendants still own output pipes.
    let _ = child.start_kill();
    tokio::time::timeout(REAP, child.wait())
        .await
        .ok()
        .and_then(Result::ok)
        .or(status)
}

/// Call after requesting application-level shutdown; force cleanup is bounded.
pub fn stop_sync(child: &mut SyncChild) {
    #[cfg(unix)]
    let _ = child.signal(libc::SIGTERM);
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let _ = child.start_kill();
    let deadline = Instant::now() + REAP;
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    tracing::warn!("process tree did not finish within shutdown deadline");
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn stop_reclaims_descendants_and_their_pipes() {
        use tokio::io::AsyncReadExt;
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("late-write");
        let mut command = tokio::process::Command::new("sh");
        command
            .arg("-c")
            .arg("(sleep 1; echo late > \"$1\") & echo ready; wait")
            .arg("sh")
            .arg(&marker)
            .stdout(std::process::Stdio::piped());
        let mut child = spawn_async(command).unwrap();
        let mut stdout = child.stdout().take().unwrap();
        let mut ready = [0; 6];
        stdout.read_exact(&mut ready).await.unwrap();
        stop_async(&mut child).await;
        let mut rest = Vec::new();
        tokio::time::timeout(REAP, stdout.read_to_end(&mut rest))
            .await
            .unwrap()
            .unwrap();
        tokio::time::sleep(Duration::from_millis(1100)).await;
        assert!(!marker.exists());
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    #[test]
    fn tree_helper() {
        let Ok(mode) = std::env::var("ECHO_SUPERVISOR_HELPER") else {
            return;
        };
        let marker = std::env::var("ECHO_SUPERVISOR_MARKER").unwrap();
        if mode == "grandchild" {
            std::fs::write(format!("{marker}.ready"), b"ready").unwrap();
            std::thread::sleep(Duration::from_secs(1));
            std::fs::write(marker, b"late").unwrap();
        } else {
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "process_supervisor::windows_tests::tree_helper",
                    "--nocapture",
                ])
                .env(
                    "ECHO_SUPERVISOR_HELPER",
                    if mode == "parent" {
                        "worker"
                    } else {
                        "grandchild"
                    },
                )
                .spawn()
                .unwrap();
            let _ = child.wait();
        }
    }
    #[tokio::test]
    async fn windows_job_reclaims_three_levels_and_inherited_pipes() {
        use tokio::io::AsyncReadExt;
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("late");
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "process_supervisor::windows_tests::tree_helper",
                "--nocapture",
            ])
            .env("ECHO_SUPERVISOR_HELPER", "parent")
            .env("ECHO_SUPERVISOR_MARKER", &marker)
            .stdout(std::process::Stdio::piped());
        let mut child = spawn_async(command).unwrap();
        let mut stdout = child.stdout().take().unwrap();
        let ready = dir.path().join("late.ready");
        tokio::time::timeout(Duration::from_secs(5), async {
            while !ready.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        stop_async(&mut child).await;
        tokio::time::timeout(REAP, stdout.read_to_end(&mut Vec::new()))
            .await
            .unwrap()
            .unwrap();
        tokio::time::sleep(Duration::from_millis(1100)).await;
        assert!(!marker.exists());
    }
}
