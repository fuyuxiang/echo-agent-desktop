use super::model::*;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct Store {
    pub path: PathBuf,
}
impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("拒绝打开符号链接群聊数据库".into());
        }
        let store = Self { path: path.into() };
        let c = store.connect()?;
        c.execute_batch("CREATE TABLE IF NOT EXISTS team_templates(id TEXT PRIMARY KEY,name TEXT NOT NULL,data TEXT NOT NULL);").map_err(|e|e.to_string())?;
        c.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS members(session_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, member_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, group_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(group_id,seq)); CREATE INDEX IF NOT EXISTS message_group ON messages(group_id,seq); CREATE TABLE IF NOT EXISTS work_items(id TEXT PRIMARY KEY, group_id TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS work_group ON work_items(group_id); PRAGMA user_version=1;").map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        Ok(store)
    }
    fn connect(&self) -> Result<Connection, String> {
        let c = Connection::open(&self.path).map_err(|e| e.to_string())?;
        c.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        Ok(c)
    }
    pub fn templates(&self) -> Result<Vec<super::management::TeamTemplate>, String> {
        let c = self.connect()?;
        let mut statement = c
            .prepare("SELECT data FROM team_templates ORDER BY name LIMIT 500")
            .map_err(|e| e.to_string())?;
        let result = statement
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .map(|r| {
                serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
            })
            .collect();
        result
    }
    pub fn save_template(&self, template: &super::management::TeamTemplate) -> Result<(), String> {
        self.connect()?.execute("INSERT INTO team_templates VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data",params![template.id,template.name,serde_json::to_string(template).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn delete_template(&self, id: &str) -> Result<(), String> {
        self.connect()?
            .execute("DELETE FROM team_templates WHERE id=?", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn list(&self) -> Result<Vec<Group>, String> {
        let c = self.connect()?;
        let mut q = c
            .prepare("SELECT data FROM groups ORDER BY updated DESC LIMIT 500")
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|s| {
            serde_json::from_str(&s.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }
    fn read(c: &Connection, id: &str) -> Result<Group, String> {
        let data: String = c
            .query_row("SELECT data FROM groups WHERE id=?", [id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or("群聊不存在")?;
        let mut g: Group = serde_json::from_str(&data).map_err(|e| format!("群配置损坏：{e}"))?;
        let mut q = c
            .prepare("SELECT data FROM messages WHERE group_id=? ORDER BY seq")
            .map_err(|e| e.to_string())?;
        g.messages = q
            .query_map([id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .map(|r| {
                serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
            })
            .collect::<Result<_, _>>()?;
        let mut q = c
            .prepare("SELECT data FROM work_items WHERE group_id=? ORDER BY rowid")
            .map_err(|e| e.to_string())?;
        g.works = q
            .query_map([id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .map(|r| {
                serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
            })
            .collect::<Result<_, _>>()?;
        Ok(g)
    }
    pub fn get(&self, id: &str) -> Result<Group, String> {
        Self::read(&self.connect()?, id)
    }
    fn write(c: &Connection, g: &Group, previous: Option<&Group>) -> Result<(), String> {
        let mut header = g.clone();
        header.messages = g
            .messages
            .iter()
            .rev()
            .take(1)
            .cloned()
            .map(|mut m| {
                m.text = m.text.chars().take(160).collect();
                m.tool_calls.clear();
                m
            })
            .collect();
        header.works = g
            .works
            .iter()
            .rev()
            .enumerate()
            .filter(|(index, work)| *index < 100 || !work.terminal())
            .map(|(_, work)| work)
            .cloned()
            .map(|mut w| {
                w.prompt.clear();
                w.output.clear();
                w.seen_events.clear();
                w
            })
            .collect();
        c.execute("INSERT INTO groups VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated=excluded.updated", params![g.id, serde_json::to_string(&header).map_err(|e| e.to_string())?,g.updated_at]).map_err(|e| e.to_string())?;
        for m in &g.members {
            for sid in [&m.session_id, &m.discussion_session_id]
                .into_iter()
                .flatten()
            {
                c.execute(
                    "INSERT OR REPLACE INTO members VALUES(?1,?2,?3)",
                    params![sid, g.id, m.id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        let old_messages = previous
            .map(|p| {
                p.messages
                    .iter()
                    .map(|m| (m.id.as_str(), m))
                    .collect::<std::collections::HashMap<_, _>>()
            })
            .unwrap_or_default();
        let old_works = previous
            .map(|p| {
                p.works
                    .iter()
                    .map(|w| (w.id.as_str(), w))
                    .collect::<std::collections::HashMap<_, _>>()
            })
            .unwrap_or_default();
        for m in &g.messages {
            if old_messages.get(m.id.as_str()) == Some(&m) {
                continue;
            }
            c.execute("INSERT INTO messages VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE messages.group_id=excluded.group_id AND messages.seq=excluded.seq",params![m.id,g.id,m.seq,serde_json::to_string(m).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
            if c.changes() == 0 {
                return Err("消息标识已被其他群聊使用，请重新发送".into());
            }
        }
        for w in &g.works {
            if old_works.get(w.id.as_str()) == Some(&w) {
                continue;
            }
            c.execute("INSERT INTO work_items VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![w.id,g.id,serde_json::to_string(w).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    pub fn create(&self, g: &Group) -> Result<(), String> {
        let mut c = self.connect()?;
        let tx = c
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        if tx
            .query_row("SELECT 1 FROM groups WHERE id=?", [&g.id], |_| Ok(()))
            .optional()
            .map_err(|e| e.to_string())?
            .is_some()
        {
            return Err("群聊已存在".into());
        }
        Self::write(&tx, g, None)?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn update<T>(
        &self,
        id: &str,
        f: impl FnOnce(&mut Group) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut c = self.connect()?;
        let tx = c
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let mut g = Self::read(&tx, id)?;
        let previous = g.clone();
        let out = f(&mut g)?;
        if g == previous {
            return Ok(out);
        }
        g.revision += 1;
        g.updated_at = now();
        Self::write(&tx, &g, Some(&previous))?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(out)
    }
    pub fn owner(&self, session: &str) -> Result<Option<(String, String)>, String> {
        self.connect()?
            .query_row(
                "SELECT group_id,member_id FROM members WHERE session_id=?",
                [session],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())
    }
    pub fn bind_owner(&self, session: &str, group: &str, member: &str) -> Result<(), String> {
        self.connect()?
            .execute(
                "INSERT OR REPLACE INTO members VALUES(?1,?2,?3)",
                params![session, group, member],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn recover(&self) -> Result<(), String> {
        for g in self.list()? {
            self.update(&g.id, |g| {
                let mut interrupted = false;
                for w in &mut g.works {
                    if w.active() {
                        w.status = "uncertain".into();
                        w.error = Some(
                            "应用重启前执行尚未确认结束，请查看原生执行记录后决定是否重试".into(),
                        );
                        interrupted = true;
                    }
                }
                g.repair_dependencies();
                if interrupted
                    || g.works
                        .iter()
                        .any(|w| w.status == "queued" || w.status == "waiting_children")
                {
                    g.paused = true;
                }
                Ok(())
            })?;
        }
        Ok(())
    }
}
