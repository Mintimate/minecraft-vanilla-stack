# Minecraft Vanilla Stack 服务端

本包以原版生存体验为基础，模组及版本见 `MODS.md`。`pack.lock.json` 是构建自动生成的运行清单，无需手动维护。默认 vanilla-plus 提供性能优化、信息辅助、附近语音和 FastBack 世界快照；其他 YAML 配方可选择不同内容。请完整解压到独立目录，保留相对路径。

包内包含锁定的服务端模组及 Fabric 引导器；首次启动需要联网下载官方 Minecraft 服务端和运行库。本包未预先接受 EULA，也不预置玩家或管理员。

## 首次启动

1. 安装 **Java __JAVA_MAJOR__**，设置 `JAVA_HOME` 或确保 `java` 在 PATH 中。脚本允许该主版本或更新版本，建议先用锁定主版本验收。
2. 阅读 [Minecraft EULA](https://www.minecraft.net/eula)，仅在自行同意后将 `eula.txt` 的 `eula=false` 改为 `eula=true`。
3. 若包内含 `fastback.py`，先按下方步骤安装 Git/Git LFS 并初始化备份。未包含 FastBack 的包跳过。
4. Linux/macOS 执行 `sh ./start.sh`；Windows 命令提示符执行 `start.bat`。
5. 等待控制台出现 `Done`，输入 `whitelist add PlayerName` 添加玩家，再用 `whitelist list` 核查。控制台命令不加 `/`。

同机连接 `localhost:25565`，其他玩家连接服主提供的服务器地址。公网使用需自行配置防火墙与端口转发。默认开启正版验证、白名单和强制白名单；不要通过关闭正版验证解决网络问题。

正常停服请在控制台输入 `stop`，等待保存与关服快照结束。默认出生点保护为 16 格，可停服修改 `spawn-protection`。添加白名单无需赋予玩家 OP。

## 配置与客户端

默认 ZIP 启动堆内存为 `1G`–`5G`，可通过 `MC_MIN_MEMORY`、`MC_MAX_MEMORY` 调整。例如：

```sh
MC_MIN_MEMORY=1G MC_MAX_MEMORY=4G sh ./start.sh
```

Windows 使用 `set MC_MIN_MEMORY=1G`、`set MC_MAX_MEMORY=4G` 后执行 `start.bat`。为操作系统和 Java 非堆内存预留空间。默认视距 10、模拟距离 6、最多 10 人、生存模式、普通难度。

`server.properties` 中的 `motd` 默认是 `Minecraft Vanilla Stack`；可使用自有 64×64 PNG 作为 `server-icon.png`，项目不附带社区品牌图标。修改后重启生效。

客户端与服务端必须使用相同 Minecraft 版本。普通原版客户端可尝试连接；整合包客户端提供 Jade、投影、地图、物品管理和画面优化等功能。具体组合应实际登录验收。客户端专用模组不要复制进服务端，当前配方没有自动建造或修改红石规则等内容。

## 可选语音

`MODS.md` 包含 Plasmo Voice 时，客户端也需安装对应版本才能收发语音。默认按 `V` 配置设备，48 格内交谈，另需放行 **24454/UDP**。配置位于 `config/plasmovoice/server/config.toml`，具体操作见包内 `docs/voice-chat.md`。未选择语音的配方无需开放此端口。

## 可选 FastBack

`MODS.md` 包含 FastBack 时，直接运行 ZIP 需安装 Git、Git LFS 和 Python 3.10+，在已自行接受 EULA 后初始化：

```sh
git --version
git lfs version
mkdir -p ../backups
python3 fastback.py init --data-dir . --backup-dir ../backups --world world
```

`world` 必须与 `server.properties` 的 `level-name` 一致。Windows 先创建父级 `backups` 目录，再用 `py -3` 运行；符号链接需要开发者模式或相应权限。初始化保留已有世界，把世界的 `.git` 链到外部 `backups/repos/<世界名>.git`，并生成精确的 `allowed_symlinks.txt` 规则；未知仓库或身份冲突会拒绝处理。

默认每 60 分钟到期，在随后一次原版自动保存时执行 `full-gc`；正常关服创建本地快照。保留数量设为 24；已有自定义 Git 配置保留。快照只保存世界、维度和玩家数据，不包含服务端配置与名单。

管理员可在控制台使用 `backup local`、`backup list`、`backup info`。初始化、导出、恢复与完整迁移见包内 `docs/backups.md`。完整备份必须同时保留服务端目录与整个外部 Git/LFS 仓库；不要只复制 `.git` 链接。

## Docker、RCON 与更新

[Docker 指南](https://cnb.cool/Mintimate/tool-forge/minecraft-vanilla-stack/-/blob/main/docs/docker.md) 提供双命名卷快速开服、可选 RCON、维护和恢复步骤。Docker 会根据包的功能声明选择是否初始化 FastBack；ZIP 启动脚本只负责启动 Java。

默认 RCON、查询接口与管理服务器关闭。直接运行 ZIP 时，可停服后按原生服务端方式配置 RCON；Docker 使用显式 `MC_RCON_ENABLED` 开关及独立覆盖文件。游戏镜像不包含 Web 管理进程。

更新 Minecraft、Fabric 或模组前先停服备份，在世界副本测试。不要假定更新后的世界可以安全降级。正式使用前至少验证整合包客户端登录、同版本原版客户端登录、白名单拦截、存档重启；启用语音时验证双向通话，启用 FastBack 时创建并导出快照检查恢复内容。
