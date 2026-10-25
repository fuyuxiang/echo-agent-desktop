//! Native allocation of independent task directories. Existing sessions are
//! never relocated or recreated when their directory disappears.
use std::path::{Path, PathBuf};

pub(crate) fn is_task_directory(base: &Path, path: &Path) -> bool {
    path.parent()
        .is_some_and(|parent| parent == base.join("Tasks"))
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| uuid::Uuid::parse_str(name).is_ok_and(|id| id.to_string() == name))
}

pub(crate) fn prepare_task_directory(base: &Path, request_id: &str) -> Result<PathBuf, String> {
    let id = uuid::Uuid::parse_str(request_id).map_err(|_| "任务目录请求 ID 无效")?;
    if id.to_string() != request_id {
        return Err("任务目录请求 ID 无效".into());
    }
    let base = base
        .canonicalize()
        .map_err(|e| format!("默认任务目录不可用：{e}"))?;
    let tasks = base.join("Tasks");
    create_owned_directory(&tasks)?;
    if tasks.canonicalize().map_err(|e| e.to_string())? != tasks {
        return Err("默认任务目录不能通过链接指向其他位置".into());
    }
    let task = tasks.join(request_id);
    create_owned_directory(&task)?;
    if task.canonicalize().map_err(|e| e.to_string())? != task {
        return Err("任务目录不能通过链接指向其他位置".into());
    }
    Ok(task)
}

fn create_owned_directory(path: &Path) -> Result<(), String> {
    match std::fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let meta = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
            if meta.is_dir() && !meta.file_type().is_symlink() {
                Ok(())
            } else {
                Err("任务目录位置已被文件或链接占用".into())
            }
        }
        Err(e) => Err(format!("无法创建任务目录：{e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_directories_are_isolated_and_retryable() {
        let base = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::now_v7().to_string();
        let first = prepare_task_directory(base.path(), &id).unwrap();
        std::fs::write(first.join("result.txt"), "kept").unwrap();
        assert_eq!(prepare_task_directory(base.path(), &id).unwrap(), first);
        let second =
            prepare_task_directory(base.path(), &uuid::Uuid::now_v7().to_string()).unwrap();
        assert_ne!(first, second);
        assert!(is_task_directory(
            &base.path().canonicalize().unwrap(),
            &first
        ));
        assert!(!is_task_directory(
            base.path(),
            &base.path().join("Tasks/my-project")
        ));
        assert!(!second.join("result.txt").exists());
        assert_eq!(
            std::fs::read_to_string(first.join("result.txt")).unwrap(),
            "kept"
        );
        assert!(prepare_task_directory(base.path(), "../../elsewhere").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn cannot_allocate_through_a_symlink() {
        let base = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), base.path().join("Tasks")).unwrap();
        assert!(prepare_task_directory(base.path(), &uuid::Uuid::now_v7().to_string()).is_err());
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    }
}
