@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"

rem Replaced by the pack builder.
set "REQUIRED_JAVA_MAJOR=__JAVA_MAJOR__"
echo(%REQUIRED_JAVA_MAJOR%| findstr /r /x "[0-9][0-9]*" >nul
if errorlevel 1 (
    echo Error: This server template has not been built: Java version is unset.
    exit /b 1
)
if not defined MC_MIN_MEMORY set "MC_MIN_MEMORY=1G"
if not defined MC_MAX_MEMORY set "MC_MAX_MEMORY=5G"

set "JAVA_BIN=java.exe"
if defined JAVA_HOME set "JAVA_BIN=%JAVA_HOME%\bin\java.exe"
if defined JAVA_HOME if not exist "%JAVA_BIN%" (
    echo Error: JAVA_HOME does not contain bin\java.exe.
    exit /b 1
)

rem A temporary file avoids cmd.exe quoting issues with Java paths containing spaces.
set "JAVA_CHECK_FILE=%TEMP%\minecraft-vanilla-stack-java-%RANDOM%-%RANDOM%.tmp"
"%JAVA_BIN%" -XshowSettings:properties -version >"%JAVA_CHECK_FILE%" 2>&1
if errorlevel 1 (
    del /q "%JAVA_CHECK_FILE%" >nul 2>&1
    echo Error: Java could not start. Install Java %REQUIRED_JAVA_MAJOR% or newer, or set JAVA_HOME.
    exit /b 1
)
set "JAVA_MAJOR="
for /f "usebackq tokens=1,2,3" %%A in ("%JAVA_CHECK_FILE%") do if "%%A"=="java.specification.version" set "JAVA_MAJOR=%%C"
del /q "%JAVA_CHECK_FILE%" >nul 2>&1
if not defined JAVA_MAJOR (
    echo Error: Could not determine the Java version.
    exit /b 1
)
if "%JAVA_MAJOR%"=="1.8" set "JAVA_MAJOR=8"
if "%JAVA_MAJOR%"=="1.7" set "JAVA_MAJOR=7"
if "%JAVA_MAJOR%"=="1.6" set "JAVA_MAJOR=6"
if %JAVA_MAJOR% LSS %REQUIRED_JAVA_MAJOR% (
    echo Error: Java %REQUIRED_JAVA_MAJOR% or newer is required; found Java %JAVA_MAJOR%.
    exit /b 1
)

if not exist "fabric-server-launch.jar" (
    echo Error: fabric-server-launch.jar is missing. Extract the complete built server archive.
    exit /b 1
)
if not exist "eula.txt" (
    echo Error: eula.txt is missing. Read README.md and the Minecraft EULA before starting.
    exit /b 1
)
set "EULA_AGREED="
for /f "tokens=1,2 delims== " %%A in (eula.txt) do if "%%A"=="eula" if "%%B"=="true" set "EULA_AGREED=true"
if not defined EULA_AGREED (
    echo Read https://www.minecraft.net/eula and, only if you agree, change eula=false to eula=true in eula.txt.
    exit /b 1
)

echo Starting server with Java %JAVA_MAJOR%, minimum memory %MC_MIN_MEMORY%, maximum memory %MC_MAX_MEMORY%.
"%JAVA_BIN%" "-Xms%MC_MIN_MEMORY%" "-Xmx%MC_MAX_MEMORY%" -jar fabric-server-launch.jar nogui
exit /b %ERRORLEVEL%
