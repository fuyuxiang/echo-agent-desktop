//! Compile and exercise the exact production native modules independently of
//! Tauri's platform webview/linker dependencies. This is not Runtime acceptance.
#![allow(dead_code)]
#[path = "../../src-tauri/src/automation/accessibility/mod.rs"]
mod accessibility;
#[path = "../../src-tauri/src/automation/computer.rs"]
mod computer;
#[path = "../../src-tauri/src/automation/desktop_coordinator.rs"]
mod desktop_coordinator;
#[cfg(all(test, target_os = "macos"))]
mod host_probe {
    use super::accessibility;
    #[test]
    #[ignore = "Read-only graphical seat diagnostic; requires an unlocked real console"]
    fn actual_desktop_seat() {
        let capability = super::computer::ComputerController::capability();
        println!("desktopAvailable={:?}", capability.desktop_available);
        assert_eq!(capability.desktop_available, Some(true));
        assert!(!super::computer::ComputerController::displays().unwrap().is_empty());
    }
    #[test]
    #[ignore = "Requires real Accessibility consent for this executable; diagnostic only, not Runtime acceptance"]
    fn actual_native_permission_and_windows() {
        println!(
            "native capability: {}",
            serde_json::to_string(&accessibility::capability()).unwrap()
        );
        let backend = accessibility::macos_probe();
        assert!(backend.is_ok(), "{}", backend.err().unwrap_or_default());
    }
}

#[path = "../../src-tauri/src/automation/task.rs"]
mod task;

#[path = "../../vendor/echo-agent-build/crates/codegen/echo-agent-runtime/src/session/helpers/tool_input_parsing.rs"]
mod tool_input_parsing;

#[path = "../../src-tauri/src/automation/artifact.rs"]
mod artifact;
#[path = "../../src-tauri/src/automation/arguments.rs"]
mod arguments;
