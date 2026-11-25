# Builds "Minidrone Ground Station.exe" (single file, no Python needed on the target laptop).
# Usage:  powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

python -m pip install --quiet -r requirements.txt pyinstaller
python tools/make_icon.py | Out-Null

python -m PyInstaller --noconfirm --clean --onefile --windowed `
    --name "Minidrone Ground Station" `
    --icon "$PSScriptRoot\ui\icon.ico" `
    --add-data "$PSScriptRoot\ui;ui" `
    --hidden-import scipy.io --hidden-import paramiko `
    --exclude-module matplotlib --exclude-module tkinter --exclude-module playwright `
    --exclude-module IPython --exclude-module pandas `
    --distpath dist --workpath build/pyinstaller --specpath build `
    app.py
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

Write-Host "`nBuilt: $PSScriptRoot\dist\Minidrone Ground Station.exe"
