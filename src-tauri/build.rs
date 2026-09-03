use std::process::Command;

fn git_output(manifest_dir: &std::path::Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(manifest_dir)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty())
}

fn main() {
    let manifest_dir = std::path::PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("Cargo must set CARGO_MANIFEST_DIR"),
    );
    let commit = std::env::var("ECHOAGENT_BUILD_COMMIT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| git_output(&manifest_dir, &["rev-parse", "--short=12", "HEAD"]))
        .unwrap_or_else(|| "unknown".into());
    let build_time = std::env::var("ECHOAGENT_BUILD_TIME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| git_output(&manifest_dir, &["show", "-s", "--format=%cI", "HEAD"]))
        .unwrap_or_else(|| "unknown".into());

    println!("cargo:rustc-env=ECHOAGENT_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=ECHOAGENT_BUILD_TIME={build_time}");
    println!("cargo:rerun-if-env-changed=ECHOAGENT_BUILD_COMMIT");
    println!("cargo:rerun-if-env-changed=ECHOAGENT_BUILD_TIME");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    tauri_build::build()
}
