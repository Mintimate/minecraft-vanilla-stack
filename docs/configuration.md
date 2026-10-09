# YAML 预设维护

每个 `packs/<id>.yaml` 定义一套客户端与服务端。复制已有 YAML、修改 `id` 与名称即可增加套包；ID 与文件名一致，使用小写字母、数字及连字符。

顶层字段为 `id`、`name`、`version`、`summary`、`minecraft`、`java`、`fabric_loader`、`server_launcher`、`mods` 和 `resourcepacks`。游戏与 Fabric 版本写成字符串。以下地址和哈希为占位示例，替换成真实固定文件后再验证：

```yaml
id: my-pack
name: My Minecraft Pack
version: "0.1.0"
summary: A small vanilla survival pack
minecraft: "26.3"
java: 25
fabric_loader: "0.19.5"
server_launcher:
  url: https://example.org/fabric-server-launch.jar
  filename: fabric-server-launch.jar
  sha512: "完整128位SHA-512"
mods:
  - id: example-mod
    url: https://example.org/releases/1.0.0/example-mod.jar
    filename: example-mod.jar
    sha512: "完整128位SHA-512"
    sides: [client, server]
    license: MIT
    requires: []
resourcepacks: []
```

`url` 必须指向完整的 HTTPS JAR 或资源包 ZIP 文件，不填项目主页。每次升级同时更新 URL、文件名和 SHA-512；可用 `shasum -a 512 文件名` 计算哈希。`sides` 为 `[client]`、`[server]` 或 `[client, server]`。模组的 `license` 保留上游许可；有必需依赖时通过 `requires` 引用同一 YAML 内的模组 ID，并在相应端明确列出依赖。

`resourcepacks` 使用 `id`、`url`、`filename`、`sha512`，只进入客户端，不填写 `sides`。没有资源包时使用空列表。构建不会查询上游、自动选择兼容版本或添加模组，维护者负责组合与游戏内验证。

## 配置与构建

默认配置集中于 `templates/client/` 和 `templates/server/`。客户端 REI、IPN 配置按对应模组是否存在保留；没有世界地图时移除默认 `J` 键。服务端语音与 FastBack 配置同样按模组选择。没有每套包的源码 `overrides/` 目录；`.mrpack` 内的 `overrides/` 是整合包格式规定的目录，必须保留。

```sh
python3 tools/build.py list
python3 tools/build.py validate --pack my-pack
python3 tools/build.py build --pack my-pack --side both
python3 tools/build.py build --pack my-pack --offline
```

省略 `--pack` 时处理全部预设。下载缓存按哈希复用，离线构建需要缓存完整且每次仍检查 SHA-512。输出位于 `build/<id>/<side>/` 和 `dist/<id>/`，包含 HMCL `.mrpack`、服务端 ZIP 与校验清单。

构建生成的 `MODS.md` 与 `pack.lock.json` 用于记录实际内容和兼容 Docker 运行时；它们无需人工维护或提交。源码仅维护 YAML，修改后验证并构建即可。
