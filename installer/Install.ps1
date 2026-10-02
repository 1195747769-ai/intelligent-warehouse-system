param(
    [string]$InstallDir,
    [string]$PayloadZip,
    [string]$SourceDir,
    [switch]$SkipShortcuts,
    [switch]$SkipRegistration,
    [switch]$NoLaunch,
    [switch]$Interactive,
    [switch]$LibraryOnly
)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + ';' + $env:PSModulePath
$privateNames = @('data','demo-data','backups','.run','.venv','local-ai','__pycache__')
$appName = '智能仓储系统'
$registryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\IntelligentWarehouse'

function Get-SafeRoot([string]$Path) {
    if (-not $Path) { throw 'Installation path is empty.' }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($full -eq [IO.Path]::GetPathRoot($full).TrimEnd('\')) { throw 'A drive root cannot be used as the application directory.' }
    $current = $full
    while ($current) {
        if (([IO.File]::Exists($current) -or [IO.Directory]::Exists($current)) -and ([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint)) { throw "Linked installation path is not supported: $current" }
        $parent = Split-Path -Parent $current
        if ($parent -eq $current) { break }
        $current = $parent
    }
    return $full
}

function Get-SafeFile([string]$Root, [string]$Relative) {
    if (-not $Relative -or $Relative.Contains('\') -or $Relative.Contains(':') -or $Relative.StartsWith('/')) { throw "Unsafe package path: $Relative" }
    foreach ($part in $Relative.Split('/')) {
        if ($part -in @('','.','..') -or $part.EndsWith('.') -or $part.EndsWith(' ') -or $part -in $privateNames -or $part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw "Unsafe package path: $Relative" }
    }
    $full = [IO.Path]::GetFullPath((Join-Path $Root $Relative))
    if (-not $full.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Package path escapes the application: $Relative" }
    $current = $full
    if ([IO.Directory]::Exists($Root)) {
        while ($current.Length -gt $Root.Length) {
            if (([IO.File]::Exists($current) -or [IO.Directory]::Exists($current)) -and ([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint)) { throw "Linked package destination: $Relative" }
            $current = [IO.Path]::GetDirectoryName($current)
        }
    }
    return $full
}

function Stop-OwnedApp([string]$Root) {
    $owned = @()
    $scripts = @('server.py','desktop_launcher.py','launcher.py','tools\prepare_inbound_demo.py') | ForEach-Object { Join-Path $Root $_ }
    foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
        if ($process.ProcessId -eq $PID) { continue }
        $exe = [string]$process.ExecutablePath
        $privateRuntime = $exe.StartsWith($Root + '\runtime\', [StringComparison]::OrdinalIgnoreCase) -or $exe.StartsWith($Root + '\.venv\', [StringComparison]::OrdinalIgnoreCase)
        if (-not $privateRuntime -and [IO.Path]::GetFileName($exe) -notmatch '^python(?:w|3(?:\.\d+)?)?\.exe$') { continue }
        $command = ([string]$process.CommandLine).Replace('/','\')
        $matchesApp = $false
        foreach ($script in $scripts) {
            $exePattern = [regex]::Escape($exe)
            $scriptPattern = [regex]::Escape($script)
            if ($command -match ('^\s*(?:"' + $exePattern + '"|' + $exePattern + ')(?:\s+-(?:B|I|u|E|s|S|O|OO))*\s+(?:"' + $scriptPattern + '"|' + $scriptPattern + ')(?:$|\s)')) { $matchesApp = $true; break }
        }
        if (-not $matchesApp) {
            if ($privateRuntime) { throw "Another program is using this application's Python runtime (PID $($process.ProcessId)). Close it before continuing." }
            continue
        }
        $owned += $process.ProcessId
    }
    foreach ($processId in $owned) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }
    foreach ($processId in $owned) {
        $running = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($running) { $running.WaitForExit(10000) | Out-Null }
    }
    return ($owned.Count -gt 0)
}

function Show-Result([string]$Message, [bool]$Failed = $false) {
    Add-Type -AssemblyName System.Windows.Forms
    $icon = if ($Failed) { [Windows.Forms.MessageBoxIcon]::Error } else { [Windows.Forms.MessageBoxIcon]::Information }
    [Windows.Forms.MessageBox]::Show($Message, $appName, [Windows.Forms.MessageBoxButtons]::OK, $icon) | Out-Null
}

if ($LibraryOnly) { return }
if ($env:MATERIALS_INSTALL_QUIET -eq '1') { $Interactive=$false }
if ($env:MATERIALS_INSTALL_NO_LAUNCH -eq '1') { $NoLaunch=$true }
if ($env:MATERIALS_INSTALL_SKIP_SHORTCUTS -eq '1') { $SkipShortcuts=$true }
if ($env:MATERIALS_INSTALL_SKIP_REGISTRATION -eq '1') { $SkipRegistration=$true }
$scratch = $null
$backup = $null
$changed = @()
try {
    if (-not $InstallDir) { $InstallDir = if ($env:MATERIALS_INSTALL_DIR) { $env:MATERIALS_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\IntelligentWarehouse' } }
    $root = Get-SafeRoot $InstallDir
    if ((Test-Path -LiteralPath $root -PathType Container) -and -not (Test-Path -LiteralPath (Join-Path $root 'server.py'))) {
        foreach ($existing in Get-ChildItem -LiteralPath $root -Force) {
            if ($existing.Name -notin $privateNames) { throw 'The target contains unrelated files. Choose an empty application folder.' }
        }
    }
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'This release requires Windows x64.' }
    if ($SourceDir -and $PayloadZip) { throw 'Choose one package source.' }
    if (-not $SourceDir -and -not $PayloadZip) { $PayloadZip = Join-Path $PSScriptRoot 'payload.zip' }
    $scratch = Join-Path ([IO.Path]::GetTempPath()) ('IntelligentWarehouse-Install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $scratch | Out-Null
    if ($SourceDir) {
        $source = Get-SafeRoot $SourceDir
        if ($source -eq $root) { throw 'The source and installed application directories must be different.' }
    }
    else {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $source = Join-Path $scratch 'package'
        New-Item -ItemType Directory -Path $source | Out-Null
        $archive = [IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($PayloadZip))
        try {
            $seen = @{}
            $expanded = 0L
            if ($archive.Entries.Count -gt 15000) { throw 'Package contains too many entries.' }
            foreach ($entry in $archive.Entries) {
                $expanded += $entry.Length
                if ($entry.Length -gt 134217728 -or $expanded -gt 536870912) { throw 'Package exceeds the core application size limit.' }
                $relative = $entry.FullName.TrimEnd('/')
                $destination = Get-SafeFile $source $relative
                if ($seen.ContainsKey($relative)) { throw "Duplicate archive path: $relative" }
                $seen[$relative] = $true
                if (($entry.ExternalAttributes -shr 16 -band 0xF000) -eq 0xA000) { throw 'Package links are not supported.' }
                if ($entry.FullName.EndsWith('/')) { New-Item -ItemType Directory -Force -Path $destination | Out-Null; continue }
                New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $false)
            }
        } finally { $archive.Dispose() }
    }
    $manifestPath = Join-Path $source 'release-manifest.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.format -ne 1 -or $manifest.version -notmatch '^\d+\.\d+\.\d+$' -or -not $manifest.files) { throw 'Invalid release manifest.' }
    $files = @($manifest.files.PSObject.Properties)
    $expected = @{'release-manifest.json'=$true}
    foreach ($file in $files) {
        $name = $file.Name
        if ($expected.ContainsKey($name)) { throw "Duplicate manifest path: $name" }
        $expected[$name] = $true
        $path = Get-SafeFile $source $name
        Get-SafeFile $root $name | Out-Null
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -ne $file.Value.bytes -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $file.Value.sha256) { throw "Package verification failed: $name" }
    }
    foreach ($required in @('server.py','intake.py','local_ai.py','launcher.py','desktop_launcher.py','runtime/python.exe','runtime/pythonw.exe','static/index.html','installer/Install.ps1','installer/Uninstall.ps1','tools/install_ai.py')) {
        if (-not $expected.ContainsKey($required)) { throw "Incomplete package: $required" }
    }
    if (-not $SourceDir) {
        foreach ($path in Get-ChildItem -LiteralPath $source -Recurse -File -Force) {
            $relative = $path.FullName.Substring($source.Length + 1).Replace('\','/')
            if (-not $expected.ContainsKey($relative)) { throw "Unlisted package file: $relative" }
        }
    }
    # Validate everything before stopping the old app or replacing its files.
    Stop-OwnedApp $root | Out-Null
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    if (Test-Path -LiteralPath (Join-Path $root 'server.py')) {
        $backup = Join-Path $root ('backups\app-upgrade-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,6))
        New-Item -ItemType Directory -Path $backup | Out-Null
    }
    foreach ($name in @($files.Name) + @('release-manifest.json')) {
        $destination = Get-SafeFile $root $name
        if ($backup -and (Test-Path -LiteralPath $destination -PathType Leaf)) {
            $saved = Join-Path $backup $name
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $saved) | Out-Null
            Copy-Item -LiteralPath $destination -Destination $saved
        }
        $changed += $name
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        Copy-Item -LiteralPath (Join-Path $source $name) -Destination $destination -Force
    }
    if (-not $SkipShortcuts) {
        $shell = New-Object -ComObject WScript.Shell
        foreach ($folder in @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('Programs')) $appName))) {
            New-Item -ItemType Directory -Force -Path $folder | Out-Null
            $shortcut = $shell.CreateShortcut((Join-Path $folder ($appName + '.lnk')))
            $shortcut.TargetPath = Join-Path $root 'runtime\pythonw.exe'
            $shortcut.Arguments = '"' + (Join-Path $root 'desktop_launcher.py') + '"'
            $shortcut.WorkingDirectory = $root
            $shortcut.Description = '智能仓储系统 · 离线本地版'
            $shortcut.Save()
        }
    }
    if (-not $SkipRegistration) {
        New-Item -Path $registryPath -Force | Out-Null
        $values = @{DisplayName=$appName; DisplayVersion=$manifest.version; Publisher='IntelligentWarehouse'; InstallLocation=$root; UninstallString=('powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $root 'installer\Uninstall.ps1') + '" -InstallDir "' + $root + '"')}
        foreach ($key in $values.Keys) { New-ItemProperty -LiteralPath $registryPath -Name $key -Value $values[$key] -PropertyType String -Force | Out-Null }
        foreach ($key in @('NoModify','NoRepair')) { New-ItemProperty -LiteralPath $registryPath -Name $key -Value 1 -PropertyType DWord -Force | Out-Null }
    }
    if (-not $NoLaunch) { Start-Process -FilePath (Join-Path $root 'runtime\pythonw.exe') -ArgumentList ('"' + (Join-Path $root 'desktop_launcher.py') + '"') -WorkingDirectory $root -WindowStyle Hidden | Out-Null }
    Write-Output "Installed $($manifest.version): $root"
    if ($Interactive) { Show-Result "安装完成。桌面双击“智能仓储系统”即可使用。`n升级已保留库存、单据、备份和本地模型。`n$root" }
} catch {
    $failure = $_.Exception.Message
    foreach ($name in $changed) {
        $destination = Get-SafeFile $root $name
        $saved = if ($backup) { Join-Path $backup $name } else { $null }
        if ($saved -and (Test-Path -LiteralPath $saved -PathType Leaf)) { Copy-Item -LiteralPath $saved -Destination $destination -Force }
        elseif (Test-Path -LiteralPath $destination -PathType Leaf) { Remove-Item -LiteralPath $destination -Force }
    }
    $failure | Out-File -LiteralPath (Join-Path ([IO.Path]::GetTempPath()) 'IntelligentWarehouse-Install.log') -Encoding UTF8
    if ($Interactive) { Show-Result ("安装未完成：" + $failure + "`n库存和单据未覆盖。") $true }
    Write-Error $failure -ErrorAction Continue
    exit 1
} finally {
    if ($scratch -and [IO.Path]::GetFullPath($scratch).StartsWith([IO.Path]::GetTempPath().TrimEnd('\') + '\IntelligentWarehouse-Install-', [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }
}
