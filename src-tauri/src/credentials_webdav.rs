//! WebDAV 密码走系统级凭据存储（macOS Keychain / Windows DPAPI / Linux 文件 fallback）。
//!
//! 原 `storage.rs::StorageProviderConfig.password` 是 `Option<String>` 直接序列化到磁盘，
//! 安全等级低（设备本地任何进程可读）。本模块提供：
//!
//! 1. `WebdavCredentialStore` trait：抽象凭据读/写/删，便于单测 mock。
//! 2. `webdav_account(provider_id)`：算 account 名（与 org.rs 风格一致，hash 化避免泄漏 provider 元数据）。
//! 3. `migrate_legacy_password` / `attach_password` / `detach_password`：迁移与运行时挂载/卸载逻辑。
//!
//! 平台实现（macOS Keychain / Windows DPAPI / Linux 文件 fallback）放在
//! `platform/` 子模块并通过 `cfg(target_os)` 切换；当前 PR 仅提供 trait + 纯逻辑层
//! 与 macOS Keychain 实现（与 org.rs 同模式），Windows/Linux 在 follow-up PR 接入。

use sha2::{Digest, Sha256};
use std::sync::{Arc, OnceLock};

use crate::storage::StorageProviderConfig;

/// 凭据存储抽象：单测可 mock，生产用平台实现。
pub trait WebdavCredentialStore: Send + Sync {
    /// 写入 secret；返回 Err 表示 Keychain/DPAPI 不可用等故障。
    fn write(&self, account: &str, secret: &str) -> Result<(), String>;
    /// 读取 secret；不存在返回 Ok(None)，故障返回 Err。
    fn read(&self, account: &str) -> Result<Option<String>, String>;
    /// 删除 secret；不存在视为 Ok。
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// 全局可注入的 store 句柄；测试时可临时替换。
static STORE: OnceLock<std::sync::Mutex<Option<Arc<dyn WebdavCredentialStore>>>> = OnceLock::new();

/// 注入平台实现（应用启动时调用一次）。
pub fn set_store(store: Arc<dyn WebdavCredentialStore>) {
    let guard = STORE.get_or_init(|| std::sync::Mutex::new(None));
    let mut g = guard.lock().expect("credential store poisoned");
    *g = Some(store);
}

/// 取出当前 store；未注入则退化为 InMemoryStore（仅供单测）。
fn current_store() -> Arc<dyn WebdavCredentialStore> {
    let guard = STORE.get_or_init(|| std::sync::Mutex::new(None));
    let g = guard.lock().expect("credential store poisoned");
    g.clone().unwrap_or_else(|| {
        static FALLBACK: OnceLock<Arc<InMemoryStore>> = OnceLock::new();
        FALLBACK
            .get_or_init(|| Arc::new(InMemoryStore::default()))
            .clone()
    })
}

/// 删除指定 provider 的凭据（删除存储源时调用）。
pub fn delete_account(provider_id: &str) -> Result<(), String> {
    let account = webdav_account(provider_id);
    current_store().delete(&account)
}

/// 算 account 名。输入 provider_id，输出形如 `echoagent-webdav-<sha256hex 前 16 位>`。
pub fn webdav_account(provider_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(provider_id.as_bytes());
    let full = digest.finalize();
    let mut hex = String::with_capacity(64);
    use std::fmt::Write as _;
    for b in full {
        let _ = write!(&mut hex, "{b:02x}");
    }
    let short = &hex[..16];
    format!("echoagent-webdav-{short}")
}

/// 一次性迁移：如果 `config.password` 仍存在（说明是从旧版 JSON 加载），把密码写进 store，
/// 然后把字段清空（避免再次序列化时落盘）。返回 true 表示发生过迁移。
///
/// 仅在配置加载（deserialize 完成后）调用一次；调用后 JSON 持久化的就是 `password: null`。
pub fn migrate_legacy_password(config: &mut StorageProviderConfig) -> bool {
    let account = webdav_account(&config.id);
    let Some(plain) = config.password.as_ref() else {
        return false;
    };
    if plain.is_empty() {
        // 空密码视为「未设置」，字段清空即可，不需要写 store
        config.password = None;
        return false;
    }
    let store = current_store();
    // 写 store 失败不阻塞迁移——password 字段还是会清空，提示用户重新输入
    let _ = store.write(&account, plain);
    config.password = None;
    true
}

/// 加载时挂载：从 store 取密码，填到 config.password（运行时使用，不写回 JSON）。
///
/// 返回 Err 时表示凭据存储不可用；此时调用方应当把 password 置 None 让用户重新输入。
pub fn attach_password(config: &mut StorageProviderConfig) -> Result<(), String> {
    let account = webdav_account(&config.id);
    let store = current_store();
    match store.read(&account) {
        Ok(Some(secret)) => {
            config.password = Some(secret);
            Ok(())
        }
        Ok(None) => Ok(()),
        Err(e) => Err(e),
    }
}

/// 保存时分离：调用方拿到来自前端的 `config`，决定如何处理 password 字段：
/// - `Some(非空)`：写入 store，然后字段置 None
/// - `Some(空)` / `None`：从 store 删除（清空凭据），字段置 None
///
/// 返回实际写入/删除操作的描述（用于日志/审计）。
pub fn detach_password(config: &mut StorageProviderConfig) -> Result<DetachOutcome, String> {
    let account = webdav_account(&config.id);
    let store = current_store();
    let outcome = match config.password.as_deref() {
        Some(s) if !s.is_empty() => {
            store.write(&account, s)?;
            DetachOutcome::Stored
        }
        _ => {
            // 不论是空字符串还是 None，都尝试删 store——保证「保存空密码 = 清空凭据」语义
            store.delete(&account)?;
            DetachOutcome::Cleared
        }
    };
    // 内存中的 password 必须清空，避免后续序列化为明文
    config.password = None;
    Ok(outcome)
}

/// 保存动作的结果描述。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetachOutcome {
    Stored,
    Cleared,
}

// ---------- 单测用 InMemoryStore ----------

/// 进程内 Map 实现的 store；仅供单测使用。
#[derive(Default)]
pub struct InMemoryStore {
    inner: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

impl WebdavCredentialStore for InMemoryStore {
    fn write(&self, account: &str, secret: &str) -> Result<(), String> {
        let mut g = self.inner.lock().expect("InMemoryStore poisoned");
        g.insert(account.to_string(), secret.to_string());
        Ok(())
    }
    fn read(&self, account: &str) -> Result<Option<String>, String> {
        let g = self.inner.lock().expect("InMemoryStore poisoned");
        Ok(g.get(account).cloned())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        let mut g = self.inner.lock().expect("InMemoryStore poisoned");
        g.remove(account);
        Ok(())
    }
}

// ---------- 平台实现 ----------

#[cfg(target_os = "macos")]
mod macos_impl {
    use super::Arc;
    use super::WebdavCredentialStore;
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };
    use security_framework_sys::base::errSecItemNotFound as ERR_SEC_ITEM_NOT_FOUND;

    const SERVICE: &str = "echoagent-webdav";
    const MAX_BYTES: usize = 4 * 1024; // 与 org.rs MAX_TOKEN_BYTES 对齐

    pub struct KeychainStore;

    impl WebdavCredentialStore for KeychainStore {
        fn write(&self, account: &str, secret: &str) -> Result<(), String> {
            if secret.len() > MAX_BYTES {
                return Err("WebDAV 密码超过 4 KiB 安全上限".into());
            }
            set_generic_password(SERVICE, account, secret.as_bytes())
                .map_err(|e| format!("write macOS Keychain credential: {e}"))
        }
        fn read(&self, account: &str) -> Result<Option<String>, String> {
            let bytes = match get_generic_password(SERVICE, account) {
                Ok(b) => b,
                Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => {
                    return Ok(None);
                }
                Err(e) => return Err(format!("read macOS Keychain credential: {e}")),
            };
            if bytes.len() > MAX_BYTES {
                return Err("WebDAV 密码超过 4 KiB 安全上限".into());
            }
            String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| "macOS Keychain credential is not valid UTF-8".into())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            match delete_generic_password(SERVICE, account) {
                Ok(()) => Ok(()),
                Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
                Err(e) => Err(format!("delete macOS Keychain credential: {e}")),
            }
        }
    }

    /// 应用启动时调用：注入平台实现。
    pub fn install() -> Arc<dyn WebdavCredentialStore> {
        Arc::new(KeychainStore)
    }
}

#[cfg(target_os = "macos")]
pub use macos_impl::install as install_platform_store;

// ---------- 单测 ----------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as TestMutex;

    /// 全局 `STORE` 是进程级单例，`set_store` 会整体替换它；Rust 测试默认并行，
    /// 并发替换会互相覆盖导致断言错乱，因此所有测试持同一把锁串行执行。
    static TEST_LOCK: TestMutex<()> = TestMutex::new(());

    macro_rules! serial {
        () => {
            let _test_guard = TEST_LOCK.lock().expect("test lock poisoned");
        };
    }

    fn fresh_store() -> Arc<InMemoryStore> {
        // 替换全局 store 为 InMemoryStore（注意：单测间需串行）
        let store = Arc::new(InMemoryStore::default());
        set_store(store.clone());
        store
    }

    fn provider(id: &str) -> StorageProviderConfig {
        StorageProviderConfig {
            id: id.into(),
            label: "test".into(),
            kind: "webdav".into(),
            base_url: "https://example.com/dav".into(),
            username: Some("user".into()),
            password: None,
            enabled: true,
        }
    }

    #[test]
    fn webdav_account_is_stable_and_prefixed() {
        let a = webdav_account("provider-a");
        let b = webdav_account("provider-a");
        let c = webdav_account("provider-b");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert!(a.starts_with("echoagent-webdav-"));
        assert_eq!(a.len(), "echoagent-webdav-".len() + 16);
    }

    #[test]
    fn migrate_legacy_password_moves_secret_into_store_and_clears_field() {
        serial!();
        let store = fresh_store();
        let mut cfg = provider("p1");
        cfg.password = Some("legacy-pw".into());

        let migrated = migrate_legacy_password(&mut cfg);
        assert!(migrated);
        assert!(cfg.password.is_none(), "迁移后 password 字段必须清空");
        // store 里有
        let account = webdav_account("p1");
        assert_eq!(store.read(&account).unwrap(), Some("legacy-pw".into()));
    }

    #[test]
    fn migrate_legacy_password_noop_when_already_none() {
        serial!();
        let _ = fresh_store();
        let mut cfg = provider("p1");
        assert!(!migrate_legacy_password(&mut cfg));
        assert!(cfg.password.is_none());
    }

    #[test]
    fn migrate_legacy_password_empty_string_treated_as_unset() {
        serial!();
        let _ = fresh_store();
        let mut cfg = provider("p1");
        cfg.password = Some("".into());
        let migrated = migrate_legacy_password(&mut cfg);
        assert!(!migrated);
        assert!(cfg.password.is_none());
    }

    #[test]
    fn detach_password_with_value_writes_and_clears_field() {
        serial!();
        let store = fresh_store();
        let mut cfg = provider("p2");
        cfg.password = Some("new-pw".into());

        let outcome = detach_password(&mut cfg).unwrap();
        assert_eq!(outcome, DetachOutcome::Stored);
        assert!(cfg.password.is_none(), "detach 后字段必须清空");
        let account = webdav_account("p2");
        assert_eq!(store.read(&account).unwrap(), Some("new-pw".into()));
    }

    #[test]
    fn detach_password_with_none_deletes_from_store() {
        serial!();
        let store = fresh_store();
        let account = webdav_account("p3");
        store.write(&account, "old").unwrap();

        let mut cfg = provider("p3");
        cfg.password = None;

        let outcome = detach_password(&mut cfg).unwrap();
        assert_eq!(outcome, DetachOutcome::Cleared);
        assert!(cfg.password.is_none());
        assert_eq!(store.read(&account).unwrap(), None);
    }

    #[test]
    fn detach_password_with_empty_string_also_clears() {
        serial!();
        let store = fresh_store();
        let account = webdav_account("p4");
        store.write(&account, "old").unwrap();

        let mut cfg = provider("p4");
        cfg.password = Some("".into());

        let outcome = detach_password(&mut cfg).unwrap();
        assert_eq!(outcome, DetachOutcome::Cleared);
        assert!(cfg.password.is_none());
        assert_eq!(store.read(&account).unwrap(), None);
    }

    #[test]
    fn attach_password_fills_field_from_store() {
        serial!();
        let store = fresh_store();
        let account = webdav_account("p5");
        store.write(&account, "secret").unwrap();

        let mut cfg = provider("p5");
        cfg.password = None;

        attach_password(&mut cfg).unwrap();
        assert_eq!(cfg.password.as_deref(), Some("secret"));
    }

    #[test]
    fn attach_password_when_missing_leaves_none() {
        serial!();
        let _ = fresh_store();
        let mut cfg = provider("p6");
        cfg.password = None;
        attach_password(&mut cfg).unwrap();
        assert!(cfg.password.is_none());
    }

    #[test]
    fn full_round_trip_via_store() {
        serial!();
        // 1. 旧版 JSON 加载进来时 password="legacy"
        // 2. migrate → store 里有，字段清空
        // 3. 运行时 attach → 字段填回
        // 4. 用户改密码为 "rotated" → detach → store 更新，字段清空
        // 5. 重新 attach → 字段填回 "rotated"
        let store = fresh_store();
        let account = webdav_account("p7");

        let mut cfg = provider("p7");
        cfg.password = Some("legacy".into());
        assert!(migrate_legacy_password(&mut cfg));
        assert!(cfg.password.is_none());
        assert_eq!(store.read(&account).unwrap(), Some("legacy".into()));

        attach_password(&mut cfg).unwrap();
        assert_eq!(cfg.password.as_deref(), Some("legacy"));

        cfg.password = Some("rotated".into());
        assert_eq!(detach_password(&mut cfg).unwrap(), DetachOutcome::Stored);
        assert!(cfg.password.is_none());
        assert_eq!(store.read(&account).unwrap(), Some("rotated".into()));

        attach_password(&mut cfg).unwrap();
        assert_eq!(cfg.password.as_deref(), Some("rotated"));
    }
}
