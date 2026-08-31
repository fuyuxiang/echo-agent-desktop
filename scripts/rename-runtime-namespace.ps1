#Requires -Version 5.0
param(
    [string]$RuntimeRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) "vendor\grok-build")
)

$ErrorActionPreference = "Stop"

git -C $RuntimeRoot rev-parse --is-inside-work-tree 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Embedded Runtime is not initialized at: $RuntimeRoot"
}

# Construct the legacy namespace without retaining it in the source tree.
$legacyRuntimeNamespace = -join @([char]120, [char]46, [char]97, [char]105)
$targetRuntimeNamespace = "echo.agent"
$relativePaths = @(git -C $RuntimeRoot grep -Iil -F $legacyRuntimeNamespace -- .)

if ($LASTEXITCODE -gt 1) {
    throw "Unable to inspect the Embedded Runtime namespace."
}

$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
$updatedFiles = 0
foreach ($relativePath in $relativePaths) {
    if ([string]::IsNullOrWhiteSpace($relativePath)) { continue }
    $sourcePath = Join-Path $RuntimeRoot $relativePath
    $content = [System.IO.File]::ReadAllText($sourcePath)
    $updated = [System.Text.RegularExpressions.Regex]::Replace(
        $content,
        [System.Text.RegularExpressions.Regex]::Escape($legacyRuntimeNamespace),
        $targetRuntimeNamespace,
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
    if ($updated -ne $content) {
        [System.IO.File]::WriteAllText($sourcePath, $updated, $utf8WithoutBom)
        $updatedFiles++
    }
}

if ($updatedFiles -eq 0) {
    Write-Host "  [OK]   Embedded Runtime namespace already uses $targetRuntimeNamespace" -ForegroundColor Green
} else {
    Write-Host "  [OK]   Migrated $updatedFiles Embedded Runtime files to $targetRuntimeNamespace" -ForegroundColor Green
}
