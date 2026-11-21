# Start PersonalHelper (dashboard + guardian) automatically when you log in to Windows.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\install_autostart.ps1
#         powershell -ExecutionPolicy Bypass -File scripts\install_autostart.ps1 -Remove
param([switch]$Remove)

$root = Split-Path -Parent $PSScriptRoot
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'PersonalHelper.lnk'

if ($Remove) {
    if (Test-Path $lnk) { Remove-Item $lnk -Confirm:$false; Write-Host "Removed $lnk" } else { Write-Host 'Not installed.' }
    exit
}

$pythonw = Join-Path $root '.venv\Scripts\pythonw.exe'
if (-not (Test-Path $pythonw)) { Write-Error "Missing $pythonw - run setup first (see README)."; exit 1 }

$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($lnk)
$s.TargetPath = $pythonw
$s.Arguments = '-m helper run'
$s.WorkingDirectory = $root
$s.Description = 'PersonalHelper dashboard + game guardian'
$s.Save()
Write-Host "Installed: $lnk"
Write-Host 'It will start at next login. Run start.bat to start it now.'
