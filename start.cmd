@echo off
chcp 65001 >nul
REM winbot launcher: use a Node 24+ binary (DSH requires Node >= 24.9).
setlocal
set "NODE_EXE="
if exist "C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE if exist "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE_EXE=%%~$PATH:I"
if not defined NODE_EXE (
  echo [winbot] node.exe not found. Install Node.js 24.9 or newer.
  exit /b 1
)
cd /d "%~dp0"
"%NODE_EXE%" "%~dp0src\main.js" %*

