@echo off
python "%~dp0tools\commentator_editor.py" %*
if errorlevel 1 pause
