# CNB 流水线与 GitHub 代码镜像

CNB 主仓库为 <https://cnb.cool/Mintimate/tool-forge/minecraft-vanilla-stack>。
游戏流水线使用 `.ci/Dockerfile` 的 Python 3.13、Git 和 jq；
Makers 使用独立的 Node.js 环境，不参与游戏发版。

- main push、PR：验证 YAML，运行游戏构建与管理测试，构建全部配方的 HMCL 包和服务端 ZIP。构建器核对下载哈希、端侧依赖和 Java 字节码。
- Web 文件变化：独立运行 Node/RCON 测试及网站构建。
- tag_push：仅 `vMAJOR.MINOR.PATCH` 发布，所有配方版本必须一致。构建每套包的 amd64/arm64 镜像，核对摘要和平台，上传 Release 附件，正式发布成功后才推广镜像 `latest`。
- main push：独立流水线将 main 同步到 GitHub。PR 不导入同步密钥，也不发布镜像或 Release。

已有版本镜像会被拒绝。上传失败时保留预发布供检查，修复后使用新版本。镜像路径为
`docker.cnb.cool/<CNB仓库路径小写>/<pack-id>:v<version>`；附件包含每套包的 HMCL、服务端 ZIP、校验文件以及统一的 `Docker-images.txt`。

## GitHub 同步

`.cnb.yml` 沿用 [tuzi-async-studio 的同步配置](https://cnb.cool/Mintimate/tool-forge/tuzi-async-studio/-/blob/main/.cnb.yml)：导入共用的 `SyncToGitHub.yml`，由官方 `tencentcom/git-sync` 插件使用 `GIT_USERNAME`、`GIT_ACCESS_TOKEN` 同步 main。无需额外 enable 开关或凭据模板。

插件使用 `force: true`；[GitHub 仓库](https://github.com/Mintimate/minecraft-vanilla-stack)的 main 作为 CNB 的代码镜像，代码维护在 CNB 进行。标签在 CNB 构建游戏包、发布 Release 和 Docker 制品，不创建 GitHub Release。

CNB 构建发布使用平台提供的临时凭据；GitHub 同步为独立流水线。
