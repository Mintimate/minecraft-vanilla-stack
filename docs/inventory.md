# 物品用途、配方与背包整理

本页适用于 **`vanilla-plus` 0.1.0**，对应 Minecraft **26.3**、Fabric **0.19.5**、Java **25**。它提供 Roughly Enough Items（REI）、Inventory Profiles Next（IPN）及 ShulkerBoxTooltip；`minimal` 不包含这些功能。

## 查询用途与配方

1. 打开背包，将鼠标悬停在想查询的物品上。
2. 按 `U` 查看用途，例如铁锭可以制作哪些工具与装备。
3. 按 `G` 查看该物品的配方；也可在 REI 列表搜索后查询。

预设把配方键设为 `G`，让 `R` 用于整理。配套 `vanilla-plus` 服务端安装 REI、Cloth Config API 和 Architectury API，负责配方同步。查询不会给予物品或增加玩家权限；IPN 整理与普通潜影盒预览本身只需客户端。

## 整理物品

打开背包或受支持的容器，将鼠标移到待整理的物品区域，按 `R`。鼠标在背包区域整理背包，在箱子区域整理箱子；也可使用 IPN 界面按钮，聊天输入时不会触发整理。

默认保留快捷栏，关闭整理时补齐快捷栏、自动补货和自动换工具。关闭背包／容器后，在游戏世界中按 `R + C` 打开 IPN 配置，或从“模组 → Inventory Profiles Next”进入，调整规则与锁定槽位。若物品整理后回跳，重新打开容器确认服务端结果，再记录容器类型与日志排查。

悬停潜影盒并按住 `Shift` 可预览内容，无需放到地上；配置入口为“模组 → ShulkerBoxTooltip”。预设仅安装客户端版本，没有服务端配合的末影箱内容同步。

## 默认按键

| 按键 | 操作 |
| --- | --- |
| `U` / `G` | 背包内悬停物品查看 REI 用途／配方 |
| `R` | 整理鼠标所在的背包／容器区域 |
| `R + C` | 关闭容器后打开 IPN 配置 |
| `J` | 世界地图 |
| `M` / `M + C` | Litematica 主菜单／配置 |
| `V` | 语音设备与激活设置 |
| 左 Alt（Mac 左 Option） | 默认按住说话 |

世界地图键位在普通按键设置修改；REI、IPN 与 Litematica 有独立的快捷键设置。Xaero 的 `U` 路标管理用于游戏世界，REI 的 `U` 查询用于背包界面。

## 保留个人配置

HMCL 新建实例导入 `.mrpack` 时会带入默认配置。升级时使用新实例，已有个人配置不要直接覆盖。

- REI：`config/roughlyenoughitems/config.json5`，用途 `U`、配方 `G`，避免占用整理键 `R`。
- IPN：`config/inventoryprofilesnext/inventoryprofiles.json`，确认整理键、按鼠标区域排序、快捷栏保护与自动功能开关。
- 世界地图：个人 `options.txt` 保留时，在游戏中将地图键调整为 `J`，避免与投影 `M` 冲突。

升级前备份实例。个人世界、地图、路标与蓝图不随发行包共享。

具体模组下载地址与版本文件见 `packs/vanilla-plus.yaml` 和包内清单。安装步骤见 [HMCL 指南](client-hmcl.md)。实际使用时确认 U/G 查询、R 整理、潜影盒显示和服务端配方同步。
