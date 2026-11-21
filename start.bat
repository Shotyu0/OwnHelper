@echo off
rem Starts the game guardian + Korean reader (http://localhost:5057/reader) in the background, no console.
cd /d "%~dp0"
start "" "%~dp0.venv\Scripts\pythonw.exe" -m helper run
