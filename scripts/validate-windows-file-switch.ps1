# Run against an installed build in a normal Windows desktop session.
# No automation of the user's real projects, config, notifications or Git data.
param(
    [Parameter(Mandatory=$true)][string]$Executable,
    [Parameter(Mandatory=$true)][string]$TheiaBrowser,
    [int]$Minutes = 10
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Native Windows desktop required' }
$Executable = (Resolve-Path $Executable).Path
$TheiaBrowser = (Resolve-Path $TheiaBrowser).Path
if ($Minutes -lt 1 -or $Minutes -gt 60) { throw 'Minutes must be between 1 and 60' }
$node = Join-Path (Split-Path $TheiaBrowser -Parent) 'node\node.exe'
& $node (Join-Path $PSScriptRoot 'validate-theia-git-runtime.mjs') $TheiaBrowser
if ($LASTEXITCODE -ne 0) { throw 'Installed Git plugin failed fingerprint verification' }
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('echo-windows-switch-' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $testRoot | Out-Null
$reviewHome = New-Item -ItemType Directory -Path (Join-Path $testRoot 'home')
$legacy = New-Item -ItemType Directory -Path (Join-Path $testRoot 'empty-legacy')
$emptyGitConfig = Join-Path $testRoot 'empty.gitconfig'
[IO.File]::WriteAllText($emptyGitConfig, '')
$template = New-Item -ItemType Directory -Path (Join-Path $testRoot 'empty-template')
foreach ($case in @('plain', 'repository', 'nested\child')) {
    $project = Join-Path $testRoot $case
    New-Item -ItemType Directory -Path $project -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $project 'one.js'), "export const message = 'Windows native review';`n")
    [IO.File]::WriteAllText((Join-Path $project 'two.ts'), "export const value: number = 2;`n")
    [IO.File]::WriteAllText((Join-Path $project 'notes.txt'), "Keep scroll and unsaved edits during file switches.`n")
}
# Git init only, with isolated config/template and no commit or hooks.
foreach ($case in @('repository', 'nested')) {
    $git = New-Object Diagnostics.ProcessStartInfo
    $git.FileName = (Get-Command git.exe).Source
    $git.Arguments = 'init --template="' + $template.FullName + '" "' + (Join-Path $testRoot $case) + '"'
    $git.UseShellExecute = $false; $git.CreateNoWindow = $true
    foreach ($key in @($git.EnvironmentVariables.Keys)) { if ($key -match '^GIT_') { $git.EnvironmentVariables.Remove($key) } }
    $git.EnvironmentVariables['GIT_CONFIG_NOSYSTEM'] = '1'
    $git.EnvironmentVariables['GIT_CONFIG_GLOBAL'] = $emptyGitConfig
    $p = [Diagnostics.Process]::Start($git); $p.WaitForExit()
    if ($p.ExitCode -ne 0) { throw 'Isolated git init failed' }
}
Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
public static class EchoWindowReview {
    public class WindowEvent { public long UtcTicks; public uint Pid; public uint Event; public IntPtr Window; }
    public static ConcurrentQueue<WindowEvent> Events = new ConcurrentQueue<WindowEvent>();
    delegate void Callback(IntPtr hook, uint kind, IntPtr hwnd, int obj, int child, uint thread, uint time);
    static Callback callback = OnEvent;
    static IntPtr[] hooks;
    [StructLayout(LayoutKind.Sequential)] struct Msg { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min,uint max,IntPtr module,Callback cb,uint pid,uint thread,uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
    [DllImport("user32.dll")] static extern bool PeekMessage(out Msg msg,IntPtr hwnd,uint min,uint max,uint remove);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref Msg msg);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Msg msg);
    static void OnEvent(IntPtr hook,uint kind,IntPtr hwnd,int obj,int child,uint thread,uint time) {
        if(hwnd==IntPtr.Zero) return;
        if(kind==0x8002 && (obj!=0 || child!=0)) return;
        if(kind==0x8002 && (!IsWindowVisible(hwnd) || GetAncestor(hwnd,2)!=hwnd)) return;
        uint pid; GetWindowThreadProcessId(hwnd,out pid);
        Events.Enqueue(new WindowEvent { UtcTicks=DateTime.UtcNow.Ticks, Pid=pid, Event=kind, Window=hwnd });
    }
    public static void Start() {
        hooks = new [] { SetWinEventHook(0x8002,0x8002,IntPtr.Zero,callback,0,0,0), SetWinEventHook(3,3,IntPtr.Zero,callback,0,0,0), SetWinEventHook(0x8005,0x8005,IntPtr.Zero,callback,0,0,0) };
        foreach(var hook in hooks) if(hook==IntPtr.Zero) { Stop(); throw new Exception("WinEventHook failed"); }
    }
    public static void Pump() { Msg msg; while(PeekMessage(out msg,IntPtr.Zero,0,0,1)) { TranslateMessage(ref msg); DispatchMessage(ref msg); } }
    public static WindowEvent Take() { WindowEvent result; return Events.TryDequeue(out result) ? result : null; }
    public static void Stop() { if(hooks!=null) foreach(var hook in hooks) if(hook!=IntPtr.Zero) UnhookWinEvent(hook); }
}
'@
$source = 'EchoProcessStart-' + [Guid]::NewGuid()
$subscription = $null
$owned = @{}
$processEvents = New-Object Collections.Generic.List[object]
$windowEvents = New-Object Collections.Generic.List[object]
$pendingWindows = New-Object Collections.Generic.List[object]
$pendingStarts = @{}
$app = $null
try {
    # StartTrace retains short-lived Git PIDs that a periodic process snapshot misses.
    $subscription = Register-CimIndicationEvent -Namespace root/cimv2 -Query 'SELECT * FROM Win32_ProcessStartTrace' -SourceIdentifier $source
    [EchoWindowReview]::Start()
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Executable; $start.UseShellExecute = $false
    foreach ($key in @($start.EnvironmentVariables.Keys)) {
        if ($key -match '^(ECHO_|GROK_|OPENAI_|ANTHROPIC_|CODEX_|UI_REVIEW_|NATIVE_|OTEL_|CLAUDE_|CURSOR_|MINIMAX_|DEEPSEEK_).*' -or $key -match '^GIT_' -or $key -match '^(CONFIG_PATH|CONFIG|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|BASH_ENV|ENV|ZDOTDIR|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME|LD_PRELOAD|DYLD_INSERT_LIBRARIES)$') { $start.EnvironmentVariables.Remove($key) }
    }
    $start.EnvironmentVariables['ECHO_AGENT_REVIEW_ISOLATED'] = '1'
    $start.EnvironmentVariables['ECHO_AGENT_TELEMETRY_ENABLED'] = 'false'
    $start.EnvironmentVariables['ECHO_AGENT_TELEMETRY_TRACE_UPLOAD'] = 'false'
    $start.EnvironmentVariables['ECHO_AGENT_HOME'] = $reviewHome.FullName
    $start.EnvironmentVariables['GROK_HOME'] = $legacy.FullName
    $start.EnvironmentVariables['GIT_CONFIG_NOSYSTEM'] = '1'
    $start.EnvironmentVariables['GIT_CONFIG_GLOBAL'] = $emptyGitConfig
    $app = [Diagnostics.Process]::Start($start)
    $owned[[int]$app.Id] = $true
    Write-Host "Isolated test projects and evidence: $testRoot"
    Write-Host 'In Code Development, open plain, repository, then nested. Alternate JS/TS/text files at least 20 times EACH, including first opens and existing tabs.'
    Write-Host 'Check focus, unsaved edits, scroll, Git diff/stage, git init in plain followed by refresh, and an interactive terminal.'
    Write-Host 'Also test empty placeholder drag-selection, IME Enter, Shift+Enter, @, /, drafts, themes and desktop notification click-to-task using a test task.'
    Write-Host "Close this isolated app when finished. Maximum observation: $Minutes minutes."
    $deadline = [DateTime]::UtcNow.AddMinutes($Minutes)
    while (!$app.HasExited -and [DateTime]::UtcNow -lt $deadline) {
        [EchoWindowReview]::Pump()
        foreach ($event in @(Get-Event -SourceIdentifier $source -ErrorAction SilentlyContinue)) {
            $row = $event.SourceEventArgs.NewEvent
            $pendingStarts[[int]$row.ProcessID] = @{ Pid=[int]$row.ProcessID; ParentPid=[int]$row.ParentProcessID; Name=[string]$row.ProcessName; Utc=$event.TimeGenerated.ToUniversalTime().ToString('o') }
            Remove-Event -EventIdentifier $event.EventIdentifier
        }
        for ($round=0; $round -lt 4; $round++) {
            foreach ($processId in @($pendingStarts.Keys)) {
                $row = $pendingStarts[$processId]
                if ($owned.ContainsKey($row.ParentPid)) {
                    $owned[$processId] = $true
                    $live = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
                    $row.CommandLine = if ($live -and $live.ParentProcessId -eq $row.ParentPid) { $live.CommandLine } else { $null }
                    $processEvents.Add($row); $pendingStarts.Remove($processId)
                }
            }
        }
        while ($null -ne ($entry = [EchoWindowReview]::Take())) { $pendingWindows.Add($entry) }
        foreach ($entry in @($pendingWindows)) {
            if ($owned.ContainsKey([int]$entry.Pid)) {
                $windowEvents.Add(@{Utc=([DateTime]::new($entry.UtcTicks,[DateTimeKind]::Utc)).ToString('o');Pid=$entry.Pid;Kind=$entry.Event;Window=$entry.Window.ToInt64();ChildWindow=($entry.Pid -ne $app.Id)})
                [void]$pendingWindows.Remove($entry)
            }
        }
        # Ignore metadata from unrelated applications; no titles, screenshots or
        # command lines of unrelated processes are collected or persisted.
        if ($pendingWindows.Count -gt 2000) { $pendingWindows.RemoveRange(0, $pendingWindows.Count-1000) }
        Start-Sleep -Milliseconds 50
        $app.Refresh()
    }
} finally {
    [EchoWindowReview]::Stop()
    if ($subscription) { Unregister-Event -SourceIdentifier $source -ErrorAction SilentlyContinue; Remove-Job $subscription -Force -ErrorAction SilentlyContinue }
    $report = @{nativeWindows=$true;automaticallyPassed=$false;manualAcceptance='Required; review child-window events, file activation and interaction checks';executable=$Executable;executableSha256=(Get-FileHash $Executable -Algorithm SHA256).Hash;resources=$TheiaBrowser;dataRoot=$testRoot;processes=$processEvents.ToArray();windows=$windowEvents.ToArray()}
    [IO.File]::WriteAllText((Join-Path $testRoot 'native-windows-review.json'), ($report | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
    Write-Host "Evidence: $(Join-Path $testRoot 'native-windows-review.json')"
    if ($app -and !$app.HasExited) { Write-Host 'Observation ended; close the isolated application manually.' }
}
