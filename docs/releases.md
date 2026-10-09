# CNB 构建与发布

[CNB 主仓库](https://cnb.cool/Mintimate/tool-forge/minecraft-vanilla-stack)提供 [Releases](https://cnb.cool/Mintimate/tool-forge/minecraft-vanilla-stack/-/releases)与 Docker 制品；[GitHub](https://github.com/Mintimate/minecraft-vanilla-stack)作为自动同步的代码镜像。

- `main` 提交与 PR：通过 Python 验证 YAML、运行构建／运行时测试，构建全部套包。
- `tag_push`：`vMAJOR.MINOR.PATCH` 发布全部套包，各 YAML 的 `version` 与标签一致；构建双架构镜像，官方 Release 与附件任务成功后更新镜像 `latest`。
- Makers Web：文件改动触发独立的 Node 构建与测试，不进入游戏构建或 Docker 镜像。

发布前修改所有预设版本并在本地验证：

```sh
python3 tools/build.py validate
python3 tools/build.py build
```

提交代码，确认 `origin` 指向 CNB 主仓库，再按常规 Git 流程创建并推送版本标签，例如：

```sh
git tag v0.1.0
git push origin main v0.1.0
```

发行附件为每套包的 `<id>-client-hmcl-<mc>-<version>.mrpack`、`<id>-server-<mc>-<version>.zip`、`<id>-SHA256SUMS.txt`，以及汇总镜像摘要的 `Docker-images.txt`。客户端用 HMCL 导入；Docker 的 Compose、环境示例与管理脚本从对应标签源码取得，见 [Docker 指南](docker.md)。

镜像路径使用小写 CNB 仓库路径与套包 ID：

```text
docker.cnb.cool/mintimate/tool-forge/minecraft-vanilla-stack/vanilla-plus:v0.1.0
docker.cnb.cool/mintimate/tool-forge/minecraft-vanilla-stack/minimal:v0.1.0
```

支持 `linux/amd64` 与 `linux/arm64`，每套包各有 `latest`。固定部署优先使用 `Docker-images.txt` 中的摘要。版本快照不覆盖；发布失败后检查流水线和制品，修复后使用新版本，不移动已发布标签。路径规范见 [CNB Docker 制品库文档](https://docs.cnb.cool/zh/artifact/docker.html)。

`main` 推送由独立流水线使用现有共用密钥和官方 `tencentcom/git-sync` 插件同步到 GitHub，无需额外启用开关。GitHub main 使用 `force: true` 作为代码镜像；版本标签在 CNB 发包，不创建 GitHub Release。配置说明见 [CNB 同步说明](../.cnb/README.md)。
