# Minecraft Vanilla Stack 客户端

此 HMCL 安装包来自 YAML 预设。`vanilla-plus` 提供原版便利与性能模组，`minimal` 只提供性能／基础模组。使用与服主相同的预设和版本，具体游戏、Java、Fabric 与模组内容以随包清单为准。

## 导入与启动

1. 安装对应系统的 [HMCL](https://hmcl.huangyuhui.net/download/)，登录拥有 Minecraft Java 版游玩资格的 Microsoft 账号。
2. 将 `.mrpack` 拖入 HMCL，创建独立实例。无需解压或改后缀，模组已内含。
3. 当前预设需要游戏 Java 25，可先分配 4 GiB 最大内存。启动器自身 Java 与游戏 Java 可以不同；首次安装仍需联网准备 Minecraft、Fabric 和运行依赖。
4. 启动游戏，添加服主提供的地址。服主需要把准确的 Java 玩家名加入白名单。

Windows、macOS 与 Linux 使用同一包。完整操作见 [HMCL 指南](docs/client-hmcl.md)。升级前备份旧实例，导入新实例验证后再迁移世界、地图、路标和蓝图；个人配置不要直接覆盖。

## `vanilla-plus` 默认功能

| 功能 | 操作 |
| --- | --- |
| REI 用途／配方 | 背包内悬停物品，U 用途、G 配方 |
| IPN 整理 | 容器内 R 整理鼠标区域，默认保护快捷栏，关闭自动补货及自动换工具；R + C 打开配置 |
| 潜影盒预览 | 悬停并按住 Shift |
| 世界地图 | J，个人键位在普通控制设置调整 |
| Litematica | M 主菜单，M + C 配置，快捷键在模组 Hotkeys 调整 |
| 附近语音 | V 设置设备，默认左 Alt（Mac 左 Option）按住说话，范围 48 格 |

`minimal` 不安装这些便利模组。蓝图 `.litematic` 放到实例 `schematics/`，完整粘贴需要创造模式与服务器权限。详见 [物品管理](docs/inventory.md)与 [语音指南](docs/voice-chat.md)。

默认包的 XK 红显由 **xekr** 创作，按 [CC-BY-NC-ND-4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/)原样分发，见[官方项目](https://modrinth.com/resourcepack/xk-redstone-display)。在“选项 → 资源包”中手动启用。固定版本 `26.3.0`（`gNtjiVyH`）未标注正式 Minecraft 26.3，需实际检查显示效果；`minimal` 无资源包。

包内 `MODS.md` 记录实际内容，源码只需维护 YAML。`.mrpack` 内的 `overrides/` 是标准安装目录，包含模组及默认配置，与仓库源码配置目录无关。
