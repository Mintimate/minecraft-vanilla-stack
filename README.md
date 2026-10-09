# Minecraft Vanilla Stack

<p align="center">
  <img src="assets/mascot/hello.png" width="240" alt="吉祥物橙芽" />
</p>

「橙芽」陪你搭起自己的原版世界。

保留 Minecraft 原版生存玩法，提供客户端整合包、服务端和 Docker 快速开服工具。一份 YAML 列出模组的固定下载地址、SHA-512 与安装端，Python 直接构建，不需要维护另一份锁文件或自动解析流程。

[CNB 主仓库](https://cnb.cool/Mintimate/tool-forge/minecraft-vanilla-stack)维护代码、讨论和 [Releases](https://cnb.cool/Mintimate/tool-forge/minecraft-vanilla-stack/-/releases)，流水线自动将 `main` 同步到 [GitHub](https://github.com/Mintimate/minecraft-vanilla-stack)。项目不预设服务器地址。Makers 网页管理独立部署，通过原生 RCON 连接游戏服。

| 预设 | 客户端 | 服务端 | 资源包 |
| --- | --- | --- | --- |
| `vanilla-plus`（默认） | 22 个模组：地图、投影、整理、配方、语音及性能优化 | 11 个模组：性能优化、信息同步、语音、Spark 与 FastBack | XK 红显 |
| `minimal` | Fabric API、Sodium、FerriteCore | Fabric API、Lithium、FerriteCore | 无 |

当前版本 **0.1.0**，使用 **Minecraft 26.3 / Fabric 0.19.5 / Java 25**。具体内容见 [YAML 预设](packs/vanilla-plus.yaml)和[包内容说明](docs/PACK_CONTENTS.md)。XK 红显沿用原始固定文件，上游尚未标注正式 26.3，需游戏内确认效果。

## Docker 快速开服

<p align="center">
  <img src="assets/mascot/server.png" width="144" alt="橙芽：服务端开服" />
</p>

安装 Docker 与 Compose，克隆仓库后：

```sh
cp docker/.env.example .env
```

阅读并自行同意 [Minecraft EULA](https://www.minecraft.net/eula)后，将 `.env` 中 `EULA=false` 改为 `EULA=true`，从源码构建并启动：

```sh
docker compose -f compose.yaml -f compose.build.yaml up -d --build
docker compose logs -f minecraft
```

镜像含 Java，首次启动联网准备官方游戏与运行库。世界和 FastBack 使用独立命名卷，默认开启正版验证和白名单。放行 **25565/TCP**；默认包附近语音另用 **24454/UDP**。执行 `./manage.sh whitelist`，在控制台输入 `whitelist add PlayerName`，按 **Ctrl+P、Ctrl+Q** 脱离。

已发布镜像可直接使用 `docker compose up -d`；版本选择、精简包、备份与恢复见 [Docker 指南](docs/docker.md)。源码构建精简包时设置 `PACK_ID=minimal`，另一套世界使用不同的卷名。

## 玩家客户端

<p align="center">
  <img src="assets/mascot/client.png" width="144" alt="橙芽：玩家客户端" />
</p>

Windows、macOS 与 Linux 使用同一份 HMCL `.mrpack`，其中已包含模组。下载与服主相同的预设和版本，拖入 HMCL 创建独立实例。安装包不含 Java、Minecraft 本体或账号，首次安装仍需联网。

[HMCL 安装指南](docs/client-hmcl.md)介绍导入和升级；默认包便利键位、附近语音及资源包启用见 [物品管理](docs/inventory.md)、[语音指南](docs/voice-chat.md)与[包内容](docs/PACK_CONTENTS.md)。

## 修改 YAML 与本地构建

<p align="center">
  <img src="assets/mascot/config.png" width="144" alt="橙芽：YAML 配置" />
</p>

需要 Python 3.10+ 和 `requirements.txt` 中的依赖：

```sh
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -r requirements.txt
python3 tools/build.py list
python3 tools/build.py validate
python3 tools/build.py build --pack vanilla-plus
```

`--side client|server|both` 选择构建端，`--offline` 只使用已校验缓存。输出为 `build/<id>/<side>/` 与 `dist/<id>/`，发行客户端仅为 HMCL 内含模组 `.mrpack`，服务端为 ZIP。

编辑 `packs/<id>.yaml` 的完整文件 URL、SHA-512、文件名与端侧；全部依赖也列入 YAML。新增套包复制 YAML 并修改 ID／名称即可。默认配置集中于 `templates/`，按所选模组保留相应配置。字段说明见 [YAML 指南](docs/configuration.md)，CNB 构建和版本标签见 [发布说明](docs/releases.md)。

## 可选 Makers 网页管理

<p align="center">
  <img src="assets/mascot/admin.png" width="144" alt="橙芽：网页管理" />
</p>

`web/` 独立部署到 EdgeOne Makers，保留白名单、玩家管理、难度、规则、天气时间、救援、封禁、结构定位、状态缓存及可选官方认证代理。游戏 Docker 镜像不包含网站或云函数，默认关闭 RCON。

需要网页管理时使用 `deploy/compose.rcon.yaml`，在 Makers 配置后台密钥和 RCON 运行时变量。完整说明见 [网页后台](docs/web-admin.md)与 [Web 模块](web/README.md)。Web 的 Node 构建和测试独立于 Python 游戏构建。

贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。自有代码使用 [MIT 许可](LICENSE)，模组及资源包遵循原作者许可，见 [第三方声明](THIRD_PARTY.md)。
