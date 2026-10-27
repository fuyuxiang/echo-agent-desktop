#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    echo_desktop_stability_check::run_fixture();
}
