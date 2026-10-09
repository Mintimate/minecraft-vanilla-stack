# Docker 快速开服

默认 `vanilla-plus` 保留原版生存规则，提供现有便利模组、附近语音和 FastBack。游戏镜像只运行 Minecraft；网站与管理界面单独部署。

## 首次配置与启动

准备 Docker Engine 或 Docker Desktop 与 Compose。从本仓库源码取得 `compose.yaml`、`docker/.env.example` 与 `manage.sh`。固定版本使用对应 Git 标签的源码，并从 [CNB Releases](https://cnb.cool/Mintimate/tool-forge/minecraft-vanilla-stack/-/releases) 的 `Docker-images.txt` 选择同一版本的镜像摘要。

```sh
cp docker/.env.example .env
```

按固定版本部署时，将 `.env` 的 `MC_IMAGE` 改为 `Docker-images.txt` 中对应套包的摘要引用。已有 `.env` 时保留原文件并合并需要的字段。阅读 [Minecraft EULA](https://www.minecraft.net/eula)，仅在自行同意后把 `.env` 中的 `EULA=false` 改成 `EULA=true`，再运行：

```sh
docker compose up -d
docker compose logs -f minecraft
```

默认自动创建两个命名卷：`minecraft-vanilla-stack-data` 挂到 `/data`，`minecraft-vanilla-stack-backups` 挂到 `/backups`；首次无需创建宿主目录或修改权限。容器以 `10001:10001` 运行。已有卷保留原权限，切换 `MC_DATA_VOLUME` 或 `MC_BACKUP_VOLUME` 会选择另一个卷，不会搬迁数据。不要执行 `docker compose down -v` 删除存档卷。

首次启动需联网下载官方 Minecraft 服务端和运行库。等待日志出现 `Done` 后添加玩家白名单。默认开启正版验证和白名单，不预设玩家或管理员。

```sh
sh ./manage.sh console
```

在控制台输入 `whitelist add PlayerName`、`whitelist list`；不加 `/`。按 `Ctrl+P`、`Ctrl+Q` 脱离控制台，服务继续运行。

游戏使用 `25565/TCP`（宿主端口由 `MC_PORT` 控制）；默认包的 Plasmo Voice 使用 `24454/UDP`。按部署环境放行对应端口，语音参数见 [语音指南](voice-chat.md)。普通原版客户端可尝试连接，便利界面和语音需要对应客户端模组；正式使用前仍应做实际登录验收。

## 内存、配置与图标

默认 JVM 堆为 `1G`–`4G`，容器内存限制为 `6g`，CPU 限制为 4。分别使用 `MC_MIN_MEMORY`、`MC_MAX_MEMORY`、`MC_CONTAINER_MEMORY`、`MC_CPUS` 调整。必须为 Java 非堆内存留出空间。

`server.properties`、`config/`、玩家名单与世界由服主维护，镜像更新不会覆盖已有内容。默认不带社区品牌图标；需要时在 `/data/server-icon.png` 放置自有 64×64 PNG。默认标语为 `Minecraft Vanilla Stack`，可停服后修改 `motd`，再重启。

可选 `MC_SERVICE_PROXY_URL` 允许使用自有可信 HTTPS 服务代理访问 Minecraft 官方 HTTP API；留空直连官方。它不会转发游戏 TCP 或语音 UDP，且 `online-mode=true` 保持开启。代理独立于游戏镜像。

## 选择整合包与源码构建

部署通过 `MC_IMAGE` 选择 CNB Docker 镜像；Release 的 `Docker-images.txt` 记录镜像摘要。源码模板默认使用 `docker.cnb.cool/mintimate/tool-forge/minecraft-vanilla-stack/vanilla-plus:latest`。精简包对应 `docker.cnb.cool/mintimate/tool-forge/minecraft-vanilla-stack/minimal:latest`。CNB 制品路径使用小写仓库路径，套包 ID 作为子镜像名称，见 [CNB Docker 制品库文档](https://docs.cnb.cool/zh/artifact/docker.html)。

从源码构建时，在 `.env` 设置 `PACK_ID`（默认 `vanilla-plus`），然后：

```sh
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

Dockerfile 调用 `python3 tools/build.py build --pack <PACK_ID> --side server`，输出 `build/<PACK_ID>/server`，宿主无需 Python 或 Java。`MC_BUILD_IMAGE` 控制本地镜像名。后续管理这个实例要继续使用相同的 Compose 覆盖文件。每套包使用不同的数据卷名和备份卷名，避免两个服务共享同一世界。

YAML 中选择的 Plasmo Voice 与 FastBack 模组控制运行能力。移除 FastBack 的包不会初始化 Git 仓库，也不要求 `/backups` 存在；移除语音的包不会写入语音配置。默认 Compose 为 vanilla-plus 保留语音端口和备份卷，精简包可按需要删去这些挂载与端口。

## 可选原生 RCON

默认关闭 RCON，单独填写密码不会启用。要在 Docker 宿主使用 RCON，复制 `deploy/rcon.env.example` 为 `deploy/rcon.env` 并设置自己的密码，然后：

```sh
docker compose --env-file .env --env-file deploy/rcon.env   -f compose.yaml -f deploy/compose.rcon.yaml up -d
```

此覆盖文件显式设置 `MC_RCON_ENABLED=true`，默认只把端口发布到 `127.0.0.1:25575`；远程管理可走 SSH 隧道。`MC_RCON_PORT` 控制容器监听端口，`MC_RCON_HOST_PORT` 控制宿主映射。密码须为非空可打印 ASCII 文本。该文件含凭据，应保持私有。

运行时只改写 `enable-rcon`、`rcon.password`、`rcon.port`、`broadcast-rcon-to-ops`；其他配置保留。去掉覆盖文件并以默认 `MC_RCON_ENABLED=false` 重建后会关闭 RCON、清空已写入的 RCON 密码。游戏镜像不包含 Web 服务。

## 维护、备份与升级

```sh
sh ./manage.sh status
sh ./manage.sh logs
sh ./manage.sh backup
```

`manage.sh backup` 正常停服、等待退出、归档并校验完整 `/data`，成功后仅重启原先正在运行的容器。输出在 `backups/backup-<时间>-<随机后缀>/`，含 `data.tar.gz`、`SHA256SUMS.txt` 和镜像记录；可用 `MC_BACKUP_DIR` 改变输出目录。`MC_COMPOSE_DIR` 可指定部署目录，`COMPOSE_FILE` 与 `COMPOSE_PROJECT_NAME` 也会保留。

此冷备不包含独立 `/backups` 中的 Git/LFS 历史。完整迁移还要停止服务并复制整个备份卷：

```sh
docker compose stop minecraft
MC_CONTAINER=$(docker compose ps -aq minecraft)
test -n "$MC_CONTAINER"
mkdir -p ./backups/history-copy
docker cp "$MC_CONTAINER":/backups/. ./backups/history-copy/
```

保留全部 `repos/` 与 LFS 对象；复制后再按原配置启动。FastBack 的默认策略、快照与导出见 [备份指南](backups.md)。

升级前备份两个卷，并在副本验证。随后设置 `.env` 的 `MC_IMAGE` 到目标版本或摘要，运行 `docker compose pull` 与 `docker compose up -d`。启动器与受管理模组按构建内容更新，旧受管理 JAR 会清理；发现未知或被手工修改的 JAR 时拒绝启动并保留文件。跨 Minecraft 版本默认阻断，只有自行决定升级并完成备份后才能明确设置 `ALLOW_MINECRAFT_VERSION_CHANGE=true`，完成后恢复 `false`。回退镜像不代表世界可安全降级。

运行时有升级事务回滚和排他锁。健康检查使用 Minecraft 状态协议，不依赖 RCON。日常正常停服等待最长 10 分钟，让 FastBack 完成保存；不要强杀正在保存的游戏进程。

## 恢复 FastBack 快照

先停服保留原世界，再导出指定快照到新空目录。辅助脚本只读仓库并校验 Git blob 和 LFS 对象，不直接修改原世界。使用过额外 Compose 覆盖文件时，以下命令继续带上原来的 `-f` 参数。

```sh
docker compose stop minecraft
docker compose logs --tail 80 minecraft
docker compose run --rm --no-deps --entrypoint python3 minecraft \
  /opt/mvs/server/fastback.py list --backup-dir /backups --world world
```

从列表中选定真实快照名，替换下方示例。一次性容器使用镜像中的 Python 和辅助脚本，不启动 Minecraft：

```sh
docker compose run --rm --no-deps --entrypoint python3 minecraft \
  /opt/mvs/server/fastback.py export --backup-dir /backups --world world \
  --snapshot 'AbCD/2026-10-06_12-00-00'
```

默认输出为 `/backups/restores/world/<时间戳>`，保存在独立备份命名卷内，路径以脚本输出为准。导出目录本身就是世界内容，包含 `level.dat`，没有 `.git`；不要再套一层 `world`。`--target` 可指定另一个可写挂载内的新空目录，非空目录会被拒绝。

备份命名卷归 `10001:10001` 所有，可用 `docker cp` 从停止的容器复制导出目录到宿主。导出后保留原世界与完整 `repos/`；恢复到新卷时，另行复制原服的配置、白名单和管理员名单，不复制旧 `.mvs` 运行记录，并显式接回正确的 FastBack 历史后再启动。配置或白名单丢失时，需要从完整冷备重建。

### 将导出的世界放入新数据卷

保持服务停止，从脚本输出中取实际导出目录，替换下方路径。这里复用原容器的精确镜像，仅用其中的 Python 复制文件；原 `/data` 与 `/backups` 都只读挂载，新卷作为 `/restore`：

```sh
set -eu
MC_RESTORE_EXPORT=/backups/restores/world/实际导出目录
MC_WORLD_NAME=world
MC_RESTORE_CONTAINER=$(docker compose ps -aq minecraft)
test -n "$MC_RESTORE_CONTAINER"
test "$(docker inspect --format '{{.State.Running}}' "$MC_RESTORE_CONTAINER")" = false
test "$(docker inspect --format '{{.State.OOMKilled}}' "$MC_RESTORE_CONTAINER")" = false
MC_RESTORE_IMAGE=$(docker inspect --format '{{.Image}}' "$MC_RESTORE_CONTAINER")
MC_RESTORE_VOLUME="minecraft-vanilla-stack-restored-$(date -u +%Y%m%dT%H%M%SZ)"
docker volume create "$MC_RESTORE_VOLUME"
docker run --rm -i --user 0:0 \
  --volumes-from "$MC_RESTORE_CONTAINER:ro" \
  --mount "type=volume,source=$MC_RESTORE_VOLUME,target=/restore" \
  --entrypoint python3 "$MC_RESTORE_IMAGE" - "$MC_RESTORE_EXPORT" "$MC_WORLD_NAME" <<'PY'
from pathlib import Path
import os, shutil, sys
source, world = Path(sys.argv[1]), sys.argv[2]
target = Path('/restore')
if not world or world in ('.', '..') or '/' in world or '\\' in world:
    raise SystemExit('世界名必须是单个目录名')
if any(target.iterdir()):
    raise SystemExit('新卷非空，拒绝覆盖')
if not source.is_relative_to('/backups/restores') or '..' in source.parts or source.is_symlink():
    raise SystemExit('请使用 /backups/restores 内的导出目录')
if (any(p.is_symlink() for p in source.parents)
        or any(p.is_symlink() for p in source.rglob('*'))):
    raise SystemExit('导出目录含符号链接，拒绝复制')
if (not (source / 'level.dat').is_file()
        or not (source / '.fastback/world-id').is_file()
        or (source / '.git').exists()):
    raise SystemExit('导出世界不完整或含 .git，请重新核对')
props = Path('/data/server.properties').read_text()
levels = [line.split('=', 1)[1].strip() for line in props.splitlines()
          if line.strip().startswith('level-name=')]
if not levels or levels[-1] != world:
    raise SystemExit('世界名与旧 server.properties 的 level-name 不一致')
shutil.copytree(source, target / world)
for name in ('server.properties', 'whitelist.json', 'ops.json',
             'banned-players.json', 'banned-ips.json', 'server-icon.png', 'config'):
    item = Path('/data') / name
    if item.is_symlink() or (item.is_dir() and any(p.is_symlink() for p in item.rglob('*'))):
        raise SystemExit(f'配置含符号链接，请人工核对：{item}')
    if item.is_dir():
        shutil.copytree(item, target / name)
    elif item.is_file():
        shutil.copy2(item, target / name)
os.chown(target, 10001, 10001)
for path in target.rglob('*'):
    os.chown(path, 10001, 10001)
print('已复制到新卷；未复制旧 .mvs、.git 或修改原世界。')
PY
```

这一步复制导出的世界与原服非世界设置，不复制旧 `.mvs` 运行记录、`.git`、`allowed_symlinks.txt` 或 `mods/`；模组由选定镜像提供。任一步失败都不要启服，保留原卷与仓库排查。若原配置已经丢失，应先从完整冷备重建配置和白名单，此例不能凭世界快照补回它们。

### 显式接回历史，再启动

在 `.env` 中保留与快照对应的游戏／模组镜像，创建本地恢复覆盖文件。已有同名文件时先保留原文件，再人工合并，不能直接覆盖：

```sh
test ! -e compose.restore.yaml
cat > compose.restore.yaml <<EOF
volumes:
  mc-data:
    external: true
    name: $MC_RESTORE_VOLUME
EOF
docker compose -f compose.yaml -f compose.restore.yaml config
docker compose -f compose.yaml -f compose.restore.yaml run --rm --no-deps \
  --entrypoint python3 minecraft /opt/mvs/server/fastback.py init \
  --data-dir /data --backup-dir /backups --world "$MC_WORLD_NAME" --attach-existing
```

检查 `config` 输出仍有原来的 `/backups` 命名卷挂载。`--attach-existing` 会核对导出世界的 `.fastback/world-id` 与外置仓库身份标记，匹配后重建 `.git` 链接及运行标记，为当前仓库目标生成精确的 `allowed_symlinks.txt` 规则，并更新仓库工作目录；不会重置其他 Git 配置、快照引用或 LFS 对象。身份不匹配时停止，不要删除仓库或 world-id 来绕过检查。

接回成功后才启动：

```sh
docker compose -f compose.yaml -f compose.restore.yaml up -d
docker compose -f compose.yaml -f compose.restore.yaml logs -f minecraft
```

后续所有管理命令继续使用同一组覆盖文件；脚本可用 `COMPOSE_FILE=compose.yaml:compose.restore.yaml ./manage.sh status`。原实例必须保持停止，不能与恢复实例同时访问同一仓库。验证玩家背包、所有维度、白名单及配置，再创建并导出一次新快照。完成前保留旧卷、原始导出目录、完整 `repos/` 与对应镜像。

更多范围、初始化说明及 ZIP 服务端操作见 [FastBack 备份指南](https://cnb.cool/Mintimate/tool-forge/minecraft-vanilla-stack/-/blob/main/docs/backups.md)。游戏内自动保存、关服快照和完整恢复仍需实际验收，本文不代表已完成游戏内测试。
