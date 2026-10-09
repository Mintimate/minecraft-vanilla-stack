# HMCL 客户端安装

Windows、macOS 和 Linux 使用同一份内含模组的 `.mrpack`。当前预设为 Minecraft **26.3**、Fabric **0.19.5**、游戏 **Java 25**；具体内容以 `packs/<id>.yaml` 和包内清单为准。

从 [CNB Releases](https://cnb.cool/Mintimate/tool-forge/minecraft-vanilla-stack/-/releases)下载与服主相同的预设和版本：

| 预设 | 0.1.0 客户端文件 | 内容 |
| --- | --- | --- |
| `vanilla-plus` | `vanilla-plus-client-hmcl-26.3-0.1.0.mrpack` | 22 个模组与 XK 红显，含地图、投影、整理和语音 |
| `minimal` | `minimal-client-hmcl-26.3-0.1.0.mrpack` | 3 个性能／基础模组，无资源包 |

模组已随包提供；首次安装仍需联网准备 Minecraft、Fabric、运行库和账号验证。安装包不包含游戏本体、Java、启动器或账号。

## 导入与启动

1. 从 [HMCL 官网](https://hmcl.huangyuhui.net/download/)下载对应系统的启动器，并登录拥有 Minecraft Java 版游玩资格的 Microsoft 账号。
2. 将 `.mrpack` 拖入 HMCL 主窗口，按向导创建独立实例。无需解压、改后缀或放入 `mods/`，不要覆盖已有个人世界的实例。
3. 等待安装完成，将实例的**游戏 Java**设为 Java 25，可先分配 `4096 MiB` 最大内存。HMCL 自身 Java 与游戏 Java 可以不同，见 [HMCL Java 指南](https://docs.hmcl.net/downloads/java.html)。Apple Silicon 使用 ARM64/AArch64，Intel Mac 与常见 Intel/AMD Windows 电脑使用 x64。
4. 启动游戏，在“多人游戏 → 添加服务器”填写服主提供的地址。服主需要先添加你的准确 Java 玩家名到白名单，玩家名不是登录邮箱。

`vanilla-plus` 预置 `U` 查用途、`G` 查配方、`R` 整理、`J` 世界地图、`M` 投影（`M + C` 配置）。语音按 `V` 设置设备，默认左 Alt 按住说话，Mac 使用左 Option。详见 [物品管理](inventory.md)与[附近语音](voice-chat.md)。`minimal` 不包含这些便利模组。

XK 红显在“选项 → 资源包”中手动启用。它保留原作者 xekr 的版权与 [CC-BY-NC-ND-4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/)许可；固定资源版本未标注正式 Minecraft 26.3，需要游戏内检查显示效果，见 [包内容](https://cnb.cool/Mintimate/tool-forge/minecraft-vanilla-stack/-/blob/main/docs/PACK_CONTENTS.md)。

## 排错与升级

- 无法识别整合包：更新 HMCL，确认下载的是完整的 `.mrpack`，不要改文件后缀。
- 安装下载失败：模组已内含，仍需检查 Minecraft、Fabric、运行库及登录服务的网络。
- Java 版本错误：检查当前实例的游戏设置，避免旧实例设置覆盖全局设置。
- 无法登录服务器：确认预设、游戏版本、正版账号及白名单玩家名一致。
- 升级：备份旧实例，导入新实例验证后再迁移个人世界、地图、路标和蓝图。已有个人配置不要直接覆盖。

构建验证不能替代实际游戏启动、联机与麦克风测试。
