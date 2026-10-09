#!/bin/sh
# Linux / macOS: run from any working directory.
set -eu

SERVER_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SERVER_DIR"

# Replaced by the pack builder. Do not lower this to bypass Java requirements.
REQUIRED_JAVA_MAJOR='__JAVA_MAJOR__'
MC_MIN_MEMORY=${MC_MIN_MEMORY:-1G}
MC_MAX_MEMORY=${MC_MAX_MEMORY:-5G}

fail() {
    printf '%s\n' "Error: $*" >&2
    exit 1
}

case "$REQUIRED_JAVA_MAJOR" in
    ''|*[!0-9]*) fail 'This server template has not been built: Java version is unset.' ;;
esac

if [ -n "${JAVA_HOME:-}" ]; then
    JAVA_BIN="$JAVA_HOME/bin/java"
    [ -x "$JAVA_BIN" ] || fail "JAVA_HOME does not contain an executable bin/java: $JAVA_HOME"
else
    JAVA_BIN=$(command -v java) || fail "Java $REQUIRED_JAVA_MAJOR or newer is required. Install Java or set JAVA_HOME."
fi

JAVA_INFO=$("$JAVA_BIN" -XshowSettings:properties -version 2>&1) || fail 'Java could not start. Check JAVA_HOME and your Java installation.'
JAVA_MAJOR=$(printf '%s\n' "$JAVA_INFO" | awk -F= '
    /^[[:space:]]*java.specification.version[[:space:]]*=/ {
        value = $2
        gsub(/[[:space:]]/, "", value)
        split(value, parts, ".")
        if (parts[1] == "1") print parts[2]
        else print parts[1]
        exit
    }
')
case "$JAVA_MAJOR" in
    ''|*[!0-9]*) fail 'Could not determine the Java version.' ;;
esac
[ "$JAVA_MAJOR" -ge "$REQUIRED_JAVA_MAJOR" ] || fail "Java $REQUIRED_JAVA_MAJOR or newer is required; found Java $JAVA_MAJOR."

[ -f fabric-server-launch.jar ] || fail 'fabric-server-launch.jar is missing. Extract the complete built server archive.'
[ -f eula.txt ] || fail 'eula.txt is missing. Read README.md and the Minecraft EULA before starting.'
grep -Eq '^[[:space:]]*eula[[:space:]]*=[[:space:]]*true[[:space:]]*$' eula.txt || fail 'Read https://www.minecraft.net/eula and, only if you agree, change eula=false to eula=true in eula.txt.'

printf '%s\n' "Starting server with Java $JAVA_MAJOR, minimum memory $MC_MIN_MEMORY, maximum memory $MC_MAX_MEMORY."
exec "$JAVA_BIN" "-Xms$MC_MIN_MEMORY" "-Xmx$MC_MAX_MEMORY" -jar fabric-server-launch.jar nogui
