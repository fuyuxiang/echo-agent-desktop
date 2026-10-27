//! Read-only native process identity inventory used by the execution guard.
use echo_agent_tools::util::process_safety::ProcessIdentity;

#[cfg(unix)]
pub fn snapshot() -> Result<Vec<ProcessIdentity>, String> {
    let output = std::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,lstart=,comm="])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("无法读取系统进程列表".into());
    }
    let processes: Vec<_> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let parent = fields.next()?.parse().ok()?;
            let started = fields.by_ref().take(5).collect::<Vec<_>>().join(" ");
            let name = fields.collect::<Vec<_>>().join(" ");
            (!name.is_empty() && !started.is_empty()).then_some(ProcessIdentity {
                pid,
                parent,
                name,
                started,
            })
        })
        .collect();
    if processes.iter().any(|p| p.pid == std::process::id()) {
        Ok(processes)
    } else {
        Err("进程列表不包含当前客户端，身份核验未完成".into())
    }
}

#[cfg(windows)]
pub fn snapshot() -> Result<Vec<ProcessIdentity>, String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        },
    };
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let mut processes = Vec::new();
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut found = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while found {
        let length = entry
            .szExeFile
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(entry.szExeFile.len());
        let mut started = String::new();
        let process =
            unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID) };
        if !process.is_null() {
            let (mut creation, mut exit, mut kernel, mut user) = (
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
            );
            if unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) }
                != 0
            {
                started = ((u64::from(creation.dwHighDateTime) << 32)
                    | u64::from(creation.dwLowDateTime))
                .to_string();
            }
            unsafe { CloseHandle(process) };
        }
        processes.push(ProcessIdentity {
            pid: entry.th32ProcessID,
            parent: entry.th32ParentProcessID,
            name: String::from_utf16_lossy(&entry.szExeFile[..length]),
            started,
        });
        found = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    if processes
        .iter()
        .any(|p| p.pid == std::process::id() && !p.started.is_empty())
    {
        Ok(processes)
    } else {
        Err("无法确认当前客户端的进程身份".into())
    }
}

#[cfg(not(any(unix, windows)))]
pub fn snapshot() -> Result<Vec<ProcessIdentity>, String> {
    Err("当前平台不支持进程身份核验".into())
}
