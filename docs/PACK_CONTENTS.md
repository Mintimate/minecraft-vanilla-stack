# 整合包内容

当前 **0.1.0** 使用 Minecraft **26.3**、Fabric **0.19.5** 与 **Java 25**。完整文件地址、SHA-512、许可证与端侧维护在 [vanilla-plus YAML](https://cnb.cool/Mintimate/tool-forge/minecraft-vanilla-stack/-/blob/main/packs/vanilla-plus.yaml)和 [minimal YAML](https://cnb.cool/Mintimate/tool-forge/minecraft-vanilla-stack/-/blob/main/packs/minimal.yaml)，实际构建内容见包内 `MODS.md`。

| 预设 | 去重模组数 | 客户端模组 | 服务端模组 | 客户端资源包 |
| --- | --- | --- | --- | --- |
| `vanilla-plus` | 25 | 22 | 11 | 1 |
| `minimal` | 4 | 3 | 3 | 0 |

同一模组可以安装到两端，因此端侧数量不能相加作为去重数。全部必需依赖已经明确列入 YAML，资源包单独统计。

## 默认包功能

| 功能 | 模组与使用边界 |
| --- | --- |
| 附近语音 | Plasmo Voice 两端安装，默认 48 格、24454/UDP；见 [语音指南](voice-chat.md) |
| 用途与配方 | REI、Cloth Config、Architectury 两端安装；背包内 U 用途、G 配方 |
| 整理与预览 | IPN、libIPN、Fabric Language Kotlin 与 ShulkerBoxTooltip 客户端；R 整理鼠标区域，Shift 预览潜影盒；见 [物品管理](inventory.md) |
| 信息提示 | Jade 与 AppleSkin，保持原版方块、生物和维度 |
| 投影与地图 | Litematica、MaLiLib 与 Xaero 地图客户端；J 世界地图、M 投影，完整粘贴仍需权限 |
| 性能 | Sodium、Entity Culling、FerriteCore、Lithium 分别优化渲染、内存和服务端逻辑 |
| 性能分析与备份 | Spark 与 FastBack 服务端；FastBack 使用 Git/LFS 世界快照，见 [备份指南](backups.md) |

`minimal` 只有 Fabric API、FerriteCore、客户端 Sodium 和服务端 Lithium，不包含上述便利功能、语音或 FastBack。

## XK 红显

`vanilla-plus` 的 HMCL 包保留 **XK 红显 26.3.0**（上游版本 ID `gNtjiVyH`）。作者 **xekr**，按 [CC-BY-NC-ND-4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/)原样分发未修改 ZIP，见[官方项目](https://modrinth.com/resourcepack/xk-redstone-display)。进入游戏“选项 → 资源包”手动启用，导入不会自动启用。

该文件上游兼容列表包含至 `26.3-snapshot-10`，没有正式 `26.3`；本预设沿用固定文件，仍需游戏内验收纹理与显示。资源包可从 YAML 删除，`minimal` 不包含资源包。

## 安装与构建

客户端仅发布内含模组的 HMCL `.mrpack`，服务端发布 ZIP，Docker 运行服务端。安装包不含 Java、Minecraft 本体、账号或服务器地址，见 [HMCL 指南](client-hmcl.md)。

`python3 tools/build.py build --pack <id>` 输出 `build/<id>/<side>/` 和 `dist/<id>/`。YAML 修改后验证、构建并实际启动游戏；哈希校验不能替代图形驱动、语音与联机验收。
