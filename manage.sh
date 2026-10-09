#!/bin/sh
# Local maintenance for an existing MVS Compose deployment; never accepts EULA.
set -eu
set -f
umask 077

usage() {
    cat <<'EOF'
Usage: ./manage.sh [help|start|stop|restart|status|logs|console|whitelist|backup]

With no argument: open a menu on a terminal, or show this help otherwise.
  start      docker compose up -d --no-build minecraft
  stop       Gracefully stop using Compose's stop_grace_period.
  restart    Restart using Compose's stop_grace_period.
  status     Show running and stopped Compose containers.
  logs       Follow the most recent 100 log lines; Ctrl+C exits the viewer.
  console    Attach to the running Minecraft console interactively.
  whitelist  Show whitelist examples, then attach for manual command input.
  backup     Stop, archive /data, verify gzip/SHA-256, then resume if previously running.

MC_COMPOSE_DIR defaults to this script's directory.
COMPOSE_FILE, COMPOSE_PROJECT_NAME and Docker context settings are respected.
Example: COMPOSE_FILE=compose.yaml:compose.bind.yaml ./manage.sh backup
MC_BACKUP_DIR defaults to <deployment>/backups (relative paths use the deployment).
Backups do not restore or upgrade a server. A failed backup never starts the server automatically.
Any partial files already created are retained for inspection.
EOF
}
die() { printf 'manage.sh: %s\n' "$*" >&2; exit 1; }

[ "$#" -le 1 ] || die 'Only one command is accepted; see --help.'
if [ "$#" -eq 0 ]; then
    if [ ! -t 0 ] || [ ! -t 1 ]; then usage; exit 0; fi
    printf '%s\n' 'MVS Minecraft maintenance' '1) Start  2) Stop  3) Restart  4) Status' \
        '5) Logs   6) Console  7) Whitelist  8) Backup  0) Exit'
    printf 'Select: '
    IFS= read -r mvs_choice || exit 0
    case "$mvs_choice" in
        1) set -- start ;; 2) set -- stop ;; 3) set -- restart ;; 4) set -- status ;;
        5) set -- logs ;; 6) set -- console ;; 7) set -- whitelist ;; 8) set -- backup ;;
        0) exit 0 ;; *) die 'Unknown selection.' ;;
    esac
fi
mvs_command=$1
case "$mvs_command" in
    help|-h|--help) usage; exit 0 ;;
    start|stop|restart|status|logs|console|whitelist|backup) ;;
    *) die "Unknown command: $mvs_command" ;;
esac
case "$mvs_command" in
    console|whitelist) [ -t 0 ] && [ -t 1 ] || die 'Console attachment requires an interactive terminal.' ;;
esac

mvs_script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
mvs_directory=${MC_COMPOSE_DIR:-$mvs_script_dir}
cd -- "$mvs_directory" || die 'Deployment directory does not exist.'
mvs_directory=$(pwd -P)
if [ -n "${COMPOSE_FILE:-}" ]; then
    mvs_saved_ifs=$IFS
    IFS=${COMPOSE_PATH_SEPARATOR:-:}
    for mvs_file in $COMPOSE_FILE; do
        [ -f "$mvs_file" ] || die "Compose file does not exist: $mvs_file"
    done
    IFS=$mvs_saved_ifs
else
    mvs_has_compose=false
    for mvs_file in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
        [ ! -f "$mvs_file" ] || mvs_has_compose=true
    done
    [ "$mvs_has_compose" = true ] || die 'No Compose file in the deployment directory; refusing to search parent directories.'
fi
command -v docker >/dev/null 2>&1 || die 'Docker is required.'
docker compose version >/dev/null
compose() { docker compose --project-directory "$mvs_directory" "$@"; }

mvs_lock="$mvs_directory/.mvs-manage.lock"
mvs_locked=false
mvs_backup_active=false
mvs_backup_folder=''
cleanup() {
    if [ "$mvs_backup_active" = true ]; then
        if [ -f "$mvs_backup_folder/.helper.cid" ]; then
            mvs_helper_id=$(cat "$mvs_backup_folder/.helper.cid")
            case "$mvs_helper_id" in
                ''|*[!0-9a-f]*) ;;
                *) if [ "${#mvs_helper_id}" -eq 64 ]; then docker rm --force "$mvs_helper_id" >/dev/null 2>&1 || :; fi ;;
            esac
        fi
        printf 'Backup did not finish. Partial files: %s\nThe server has not been restarted automatically.\n' "$mvs_backup_folder" >&2
    fi
    if [ "$mvs_locked" = true ]; then
        rm -f "$mvs_lock/pid"
        rmdir "$mvs_lock" 2>/dev/null || :
    fi
}
trap cleanup 0
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
lock_maintenance() {
    mkdir "$mvs_lock" 2>/dev/null || die "Another maintenance operation owns $mvs_lock; check its pid before removing a stale lock."
    mvs_locked=true
    printf '%s\n' "$$" > "$mvs_lock/pid"
}

find_container() {
    mvs_ids=$(compose ps --all --quiet minecraft)
    set -- $mvs_ids
    [ "$#" -eq 1 ] || die 'Expected exactly one existing minecraft container; deploy it first and do not scale this service.'
    mvs_cid=$1
    [ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$mvs_cid")" = minecraft ] || die 'Container service label does not match.'
    mvs_project=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$mvs_cid")
    case "$mvs_project" in ''|'<no value>') die 'Container lacks a Compose project label.' ;; esac
    if [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then
        [ "$mvs_project" = "$COMPOSE_PROJECT_NAME" ] || die 'Container project label does not match COMPOSE_PROJECT_NAME.'
    fi
}

backup() {
    command -v gzip >/dev/null 2>&1 || die 'gzip is required to verify the backup.'
    if command -v sha256sum >/dev/null 2>&1; then mvs_hash_tool=sha256sum
    elif command -v shasum >/dev/null 2>&1; then mvs_hash_tool=shasum
    else die 'sha256sum or shasum is required.'; fi
    find_container
    mvs_state=$(docker inspect --format '{{.State.Status}}' "$mvs_cid")
    case "$mvs_state" in running|exited) ;; *) die "Cannot safely back up container state: $mvs_state" ;; esac
    mvs_image=$(docker inspect --format '{{.Image}}' "$mvs_cid")
    mvs_image_reference=$(docker inspect --format '{{.Config.Image}}' "$mvs_cid")
    mvs_image_digests=$(docker image inspect --format '{{json .RepoDigests}}' "$mvs_image")
    mvs_mount_type=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}}{{end}}{{end}}' "$mvs_cid")
    mvs_mount_source=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$mvs_cid")
    case "$mvs_mount_type" in volume|bind) ;; *) die 'A persistent volume or bind mount at /data is required.' ;; esac
    [ -n "$mvs_mount_source" ] || die 'The /data mount has no source.'
    mvs_backup_base=${MC_BACKUP_DIR:-$mvs_directory/backups}
    case "$mvs_backup_base" in /*) ;; *) mvs_backup_base="$mvs_directory/$mvs_backup_base" ;; esac
    mkdir -p "$mvs_backup_base"
    mvs_backup_base=$(CDPATH='' cd -- "$mvs_backup_base" && pwd -P)
    if [ "$mvs_mount_type" = bind ]; then
        mvs_bind_source=${mvs_mount_source%/}
        if [ -d "$mvs_mount_source" ]; then
            mvs_bind_source=$(CDPATH='' cd -- "$mvs_mount_source" && pwd -P)
            mvs_bind_source=${mvs_bind_source%/}
        fi
        case "$mvs_backup_base/" in "$mvs_bind_source/"*) die 'Backup destination must be outside the /data bind source.' ;; esac
    fi
    mvs_running_ids=$(docker ps --quiet --no-trunc)
    mvs_newline='
'
    for mvs_other in $mvs_running_ids; do
        [ "$mvs_other" != "$mvs_cid" ] || continue
        mvs_mounts=$(docker inspect --format '{{range .Mounts}}{{printf "%s:%s\n" .Type .Source}}{{end}}' "$mvs_other")
        case "$mvs_newline$mvs_mounts$mvs_newline" in
            *"$mvs_newline$mvs_mount_type:$mvs_mount_source$mvs_newline"*) die 'Another running container shares the /data source; stop it before backing up.' ;;
        esac
    done
    mvs_backup_folder=$(mktemp -d "$mvs_backup_base/backup-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
    mvs_backup_active=true
    if [ "$mvs_state" = running ]; then compose stop minecraft; fi
    mvs_exit=$(docker inspect --format '{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.Error}}' "$mvs_cid")
    case "$mvs_exit" in 'exited|0|false|'|'exited|143|false|') ;;
        *) die 'Server did not stop cleanly. Inspect its logs; backup and automatic restart are cancelled.' ;;
    esac
    printf '%s\n' 'Server is stopped. Recent logs below should show the world being saved:' >&2
    docker logs --tail 30 "$mvs_cid" >&2
    docker run --rm --pull=never --user 0:0 --network none --no-healthcheck \
        --cidfile "$mvs_backup_folder/.helper.cid" --volumes-from "$mvs_cid:ro" \
        --entrypoint python3 "$mvs_image" -c '
import fcntl, os, stat, sys, tarfile
data = "/data"
lock = "/data/.mvs/runtime.lock"
if os.path.islink(data) or os.path.islink("/data/.mvs"):
    raise SystemExit("Unsafe runtime lock path")
fd = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW)
if not stat.S_ISREG(os.fstat(fd).st_mode):
    raise SystemExit("Runtime lock is not a regular file")
# A shared read lock blocks the runtime exclusive lock without writing /data.
fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
try:
    with tarfile.open(fileobj=sys.stdout.buffer, mode="w|gz", dereference=False) as archive:
        archive.add(data, arcname=".")
finally:
    os.close(fd)
' > "$mvs_backup_folder/data.tar.gz.partial"
    gzip -t "$mvs_backup_folder/data.tar.gz.partial"
    if [ "$mvs_hash_tool" = sha256sum ]; then
        mvs_checksum=$(sha256sum "$mvs_backup_folder/data.tar.gz.partial")
    else
        mvs_checksum=$(shasum -a 256 "$mvs_backup_folder/data.tar.gz.partial")
    fi
    mvs_checksum=${mvs_checksum%% *}
    [ "${#mvs_checksum}" -eq 64 ] || die 'Invalid SHA-256 checksum output.'
    case "$mvs_checksum" in *[!0-9a-f]*) die 'Invalid SHA-256 checksum output.' ;; esac
    printf '%s  data.tar.gz\n' "$mvs_checksum" > "$mvs_backup_folder/SHA256SUMS.txt"
    printf 'IMAGE_ID=%s\nIMAGE_REFERENCE=%s\nREPO_DIGESTS=%s\nCONTAINER_ID=%s\nCOMPOSE_PROJECT=%s\nCREATED_AT=%s\n' \
        "$mvs_image" "$mvs_image_reference" "$mvs_image_digests" "$mvs_cid" "$mvs_project" \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$mvs_backup_folder/metadata.txt"
    mv "$mvs_backup_folder/data.tar.gz.partial" "$mvs_backup_folder/data.tar.gz"
    rm -f "$mvs_backup_folder/.helper.cid"
    mvs_backup_active=false
    printf 'Backup verified: %s\n' "$mvs_backup_folder/data.tar.gz"
    if [ "$mvs_state" = running ]; then
        docker start "$mvs_cid" || die "Backup is complete, but restarting $mvs_cid failed."
    fi
}

case "$mvs_command" in
    start|stop|restart|backup) lock_maintenance ;;
esac
case "$mvs_command" in
    start) compose up -d --no-build minecraft ;;
    stop) compose stop minecraft ;;
    restart) compose restart minecraft ;;
    status) compose ps --all ;;
    logs) compose logs --tail 100 --follow minecraft ;;
    console|whitelist)
        find_container
        [ "$(docker inspect --format '{{.State.Running}}' "$mvs_cid")" = true ] || die 'Start the minecraft server before attaching.'
        [ "$(docker inspect --format '{{.Config.OpenStdin}} {{.Config.Tty}}' "$mvs_cid")" = 'true true' ] || die 'The minecraft container must have stdin_open and tty enabled.'
        if [ "$mvs_command" = whitelist ]; then
            printf '%s\n' '在下面的 Minecraft 控制台手动输入（不用 /）：' \
                '  whitelist add PlayerName' '  whitelist list' '  whitelist remove PlayerName' \
                '将 PlayerName 替换为玩家的 Java 版用户名；这些示例不会自动执行。'
        fi
        printf '%s\n' '退出控制台：先按 Ctrl+P，再按 Ctrl+Q。不要输入 stop，除非你要停服。'
        docker attach --sig-proxy=false --detach-keys ctrl-p,ctrl-q "$mvs_cid"
        ;;
    backup) backup ;;
esac
