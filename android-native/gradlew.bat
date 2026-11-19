@echo off
setlocal
set "GRADLE_VERSION=8.9"
set "GRADLE_HOME=%USERPROFILE%\.gradle\smart-clock-bootstrap\gradle-%GRADLE_VERSION%"
if exist "%GRADLE_HOME%\bin\gradle.bat" goto runGradle
set "ZIP=%TEMP%\gradle-%GRADLE_VERSION%-bin.zip"
echo Gradle %GRADLE_VERSION% download is required for the first build.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Invoke-WebRequest -Uri 'https://services.gradle.org/distributions/gradle-%GRADLE_VERSION%-bin.zip' -OutFile '%ZIP%'; New-Item -ItemType Directory -Force -Path '%USERPROFILE%\.gradle\smart-clock-bootstrap' | Out-Null; Expand-Archive -Path '%ZIP%' -DestinationPath '%USERPROFILE%\.gradle\smart-clock-bootstrap' -Force; Remove-Item '%ZIP%' -Force"
if errorlevel 1 exit /b 1
:runGradle
call "%GRADLE_HOME%\bin\gradle.bat" %*
endlocal
