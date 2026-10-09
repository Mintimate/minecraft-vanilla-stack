# 可选 Makers 网页管理

Minecraft Vanilla Stack 的 `web/` 可以单独部署到 EdgeOne Makers，通过原生 RCON 管理游戏服。它提供白名单、难度与规则、玩家救援、封禁、时间／天气、保存世界以及结构定位，独立于游戏服 Docker 镜像。

1. 先完成 [Docker 开服](docker.md)或 ZIP 服务端启动，并确认服务正常。
2. 停服，编辑持久数据中的 `server.properties`：启用 `enable-rcon=true`，设置 `rcon.port=25575` 以及独立随机的 `rcon.password`，然后重启。
3. 为 Makers 云函数准备可达的受保护 RCON 入口。Docker 使用额外的 TCP 映射；主机 localhost 仅供本机连接，远端云函数不能直接访问。
4. 从 [CNB 主仓库](https://cnb.cool/Mintimate/tool-forge/minecraft-vanilla-stack)取得源码，以 `web/` 为 Makers 项目根目录上传或用 CLI 部署；也可关联 [GitHub 代码镜像](https://github.com/Mintimate/minecraft-vanilla-stack)，先核对所需提交已同步。已有配置使用 `npm ci`、`node build.mjs` 与静态输出 `dist`。
5. 配置**服务端运行时变量** `ADMIN_KEY`、`RCON_HOST`、`RCON_PASSWORD`，可选 `RCON_PORT`，保存并部署。分别用 `openssl rand -hex 32` 生成两组不同的登录与 RCON 密钥。
6. 打开站点 `/admin/` 使用登录密钥进入后台；`/admin/#locate` 直接打开结构定位。

RCON 是明文协议，网络入口应限制在受保护网络内。Makers 的网站 HTTPS 只保护浏览器与网站间通信。密钥仅保存到运行时变量，不能放到 `config.js`、Git 或静态构建目录。

首页默认只显示安装与开服指南。需要公开服务器人数和玩家名时，在 `web/config.js` 将 `MVS_SITE.publicStatusEnabled` 设为 `true` 并部署。状态接口通过 Makers Blob 缓存，游客页面每 30 秒读取管理员更新，每 5 分钟允许重新采样；隐藏标签页暂停。此开关只控制首页展示，若需完全停用公开状态接口，移除对应云函数后部署。

官方认证代理也可按需启用：Makers 设置 `MC_PROXY_PUBLIC_ORIGIN` 为站点的 HTTPS 来源；游戏服 `.env` 设置 `MC_SERVICE_PROXY_URL=https://你的站点域名/mc-proxy` 后重建容器。继续使用 `online-mode=true`。这不会代理游戏或语音流量，部署后应使用正版账号实际验证登录。

完整参数、缓存行为、命令版本兼容性、认证代理与本地验证方法见 [Web 模块说明](https://cnb.cool/Mintimate/tool-forge/minecraft-vanilla-stack/-/blob/main/web/README.md)。
