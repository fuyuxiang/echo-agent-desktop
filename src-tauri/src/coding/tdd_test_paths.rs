// Shared by the real TDD state machine and direct production-module tests.
pub fn is_test_path(path: &str) -> bool {
    let path = path.replace('\\', "/").to_lowercase();
    let name = path.rsplit('/').next().unwrap_or(&path);
    path.contains("/__tests__/")
        || path.starts_with("tests/")
        || path.contains("/tests/")
        || name.starts_with("test_")
        || name.starts_with("test-")
        || matches!(name, "test.js" | "test.cjs" | "test.mjs")
        || name.ends_with("_test.py")
        || name.ends_with("_test.rs")
        || name.ends_with("_test.go")
        || name.contains(".test.")
        || name.contains(".spec.")
        || name.ends_with("test.java")
        || name.ends_with("tests.java")
}

#[cfg(test)]
mod tests {
    use super::is_test_path;
    #[test]
    fn hyphenated_cli_tests_are_test_only_changes() {
        for path in [
            "scripts/test-native-review-window.mjs",
            "scripts/test-ui-guards.cjs",
            "test-order.js",
            r"scripts\test-window.mjs",
        ] {
            assert!(
                is_test_path(path),
                "test command input must pause for RED: {path}"
            );
        }
    }
    #[test]
    fn established_test_conventions_keep_their_classification() {
        for path in [
            "tests/order.rs",
            "src/__tests__/order.ts",
            "src/order.test.ts",
            "src/order.spec.js",
            "test_order.py",
            "src/order_test.go",
            "src/OrderTests.java",
            "scripts/test.mjs",
        ] {
            assert!(is_test_path(path), "{path}");
        }
    }
    #[test]
    fn production_paths_and_test_words_are_not_test_files() {
        for path in [
            "scripts/lib/native-review-window.mjs",
            "src/latest-state.ts",
            "src/testing/service.ts",
            "src/order.rs",
            "src/contest.ts",
            "src/testament.ts",
        ] {
            assert!(
                !is_test_path(path),
                "production file cannot bypass RED gate: {path}"
            );
        }
    }
}
