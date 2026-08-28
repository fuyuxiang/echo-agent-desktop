use xai_grok_shell::util::config::load_effective_config;

#[test]
fn configured_default_model_is_loaded() {
    // Integration tests must not depend on the developer's real
    // ~/.echo-agent/config.toml. Seed an isolated upstream home before its
    // process-global config path is initialized.
    let home = tempfile::tempdir().expect("temporary agent home");
    std::fs::write(
        home.path().join("config.toml"),
        r#"[models]
default = "glm-5"

[model.glm-5]
backend = "openai"
base_url = "https://example.invalid/v1"
api_key = "test-only"
"#,
    )
    .expect("seed config.toml");
    std::env::set_var("GROK_HOME", home.path());

    let raw = load_effective_config().expect("load_effective_config");
    let models_default = raw
        .get("models")
        .and_then(|m| m.get("default"))
        .and_then(|d| d.as_str());
    println!("[models] default = {:?}", models_default);
    assert_eq!(models_default, Some("glm-5"));

    let glm5 = raw.get("model").and_then(|m| m.get("glm-5"));
    assert!(glm5.is_some(), "configured default must have a model entry");
}
