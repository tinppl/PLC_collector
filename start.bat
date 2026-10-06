@echo off
chcp 65001 > nul
cd /d "%~dp0"
title PLC Collector

if not exist "server.py" goto :nofile

set "PY="
py -3 --version >nul 2>nul && set "PY=py -3"
if not defined PY python --version >nul 2>nul && set "PY=python"
if not defined PY goto :nopython

echo 사용할 Python:
%PY% --version
echo.
%PY% server.py
set "RC=%errorlevel%"
echo.
echo [종료됨] 종료 코드: %RC%
echo 위에 오류 메시지가 있으면 그 내용을 확인하세요.
pause
exit /b %RC%

:nofile
echo [오류] 이 폴더에서 server.py 를 찾을 수 없습니다.
echo zip 파일 안에서 바로 실행하지 말고, 압축을 먼저 푼 뒤 폴더 안의 start.bat 을 실행하세요.
echo 현재 위치: %cd%
pause
exit /b 1

:nopython
echo [오류] 실행 가능한 Python 을 찾지 못했습니다.
echo https://www.python.org 에서 설치하고, 설치 첫 화면의 "Add python.exe to PATH" 를 체크하세요.
echo Microsoft Store 의 python 바로가기만 있는 경우에도 이 메시지가 나옵니다.
pause
exit /b 1