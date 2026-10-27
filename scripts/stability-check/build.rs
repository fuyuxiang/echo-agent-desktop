fn main() {
    if std::env::var_os("CARGO_FEATURE_NATIVE_FIXTURE").is_some() {
        tauri_build::build();
    }
}
