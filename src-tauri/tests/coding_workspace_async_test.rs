//! Guards the async contract of the coding workspace commands: a long scan must
//! not block the tokio runtime, and the retired command names must be gone.

use std::time::Duration;

/// A blocking scan on a worker thread would starve this concurrent timer. With
/// the scan moved onto the blocking pool the timer keeps its own schedule.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn blocking_scan_does_not_starve_the_runtime() {
    let scan = tokio::task::spawn_blocking(|| {
        // Simulate the synchronous directory walk the real command performs.
        std::thread::sleep(Duration::from_millis(400));
        12_000usize
    });

    let mut ticks = 0u32;
    let ticker = async {
        for _ in 0..8 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            ticks += 1;
        }
    };
    let (scanned, ()) = tokio::join!(async { scan.await.unwrap() }, ticker);

    assert_eq!(scanned, 12_000);
    // All timer ticks fired while the scan was still running.
    assert_eq!(ticks, 8);
}

/// The verification engine must be the only place that spawns a command. The
/// legacy `coding_run_command` / `coding_cancel_command` entry points stay
/// registered while the pre-workbench coding UI still ships, but they must be
/// thin shims that delegate rather than a second execution path.
#[test]
fn command_execution_has_a_single_implementation() {
    let lib_source = include_str!("../src/lib.rs");
    assert!(
        lib_source.contains("coding::verification::coding_verification_run"),
        "验证引擎命令必须已注册"
    );

    let workspace_source = include_str!("../src/coding_workspace.rs");
    let shim_start = workspace_source
        .find("pub async fn coding_run_command")
        .expect("兼容入口应仍然存在，直到旧版界面下线");
    let shim = &workspace_source[shim_start..];
    let shim_body = &shim[..shim.find("\n}\n").expect("函数应有结尾")];
    assert!(
        shim_body.contains("coding::verification::run"),
        "旧入口必须委托给验证引擎，不得自行执行命令"
    );
    assert!(
        !shim_body.contains("Command::new"),
        "旧入口不得再自行创建子进程"
    );
}

/// Walk each `pub async fn` body and assert it does not reach for `std::fs`
/// directly; those calls belong inside `spawn_blocking` or a sync helper.
#[test]
fn async_commands_do_not_call_sync_fs_directly() {
    let source = include_str!("../src/coding_workspace.rs");
    let mut offenders = Vec::new();
    let mut in_async_command = false;
    let mut brace_depth = 0i32;
    let mut saw_spawn_blocking = false;

    for (index, line) in source.lines().enumerate() {
        if !in_async_command && line.starts_with("pub async fn") {
            in_async_command = true;
            brace_depth = 0;
            saw_spawn_blocking = false;
        }
        if !in_async_command {
            continue;
        }
        if line.contains("spawn_blocking") {
            saw_spawn_blocking = true;
        }
        if line.contains("std::fs::") && !saw_spawn_blocking {
            offenders.push(format!("{}: {}", index + 1, line.trim()));
        }
        brace_depth += line.matches('{').count() as i32;
        brace_depth -= line.matches('}').count() as i32;
        if brace_depth <= 0 && line.starts_with('}') {
            in_async_command = false;
        }
    }

    assert!(
        offenders.is_empty(),
        "以下 async 命令内仍有同步文件调用：\n{}",
        offenders.join("\n")
    );
}
