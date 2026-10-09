# Minecraft Vanilla Stack Web

可选的 EdgeOne Makers 网站与 RCON 管理后台。首页提供 HMCL 客户端安装、Docker 开服与 YAML 直接构建指南，下载入口指向 [CNB 主仓库](https://cnb.cool/Mintimate/tool-forge/minecraft-vanilla-stack)及 [CNB Releases](https://cnb.cool/Mintimate/tool-forge/minecraft-vanilla-stack/-/releases)。Web 部署根目录为 `web/`，游戏服 Docker 镜像只负责运行游戏服务端。游戏包由 `python3 tools/build.py` 构建，Web 保留自己的 Node 构建与测试。

## 部署

从 CNB 主仓库取得源码，以 `web/` 作为 Makers 项目根目录，使用源码上传或 CLI 部署；也可关联 [GitHub 代码镜像](https://github.com/Mintimate/minecraft-vanilla-stack)部署，先确认镜像已同步到所需提交。`edgeone.json` 提供 `npm ci` 安装、`node build.mjs` 构建和 `dist` 静态输出配置。需要 Node.js 云函数的 TCP 网络能力，因此 `cloud-functions/` 使用 `node:net`，服务端变量从 `context.env` 读取。

只需要客户端／开服指南时，可直接部署，无需配置 RCON。需要后台时，在 Makers 的**服务端运行时环境变量**中填写：

| 变量 | 用途 |
| --- | --- |
| `ADMIN_KEY` | 后台登录密钥，至少 32 字节 |
| `RCON_HOST` | 云函数能访问的 RCON 主机名／IP，不能带协议、路径或端口 |
| `RCON_PASSWORD` | 与游戏服一致，32–128 位可打印 ASCII，不含空格或换行 |
| `RCON_PORT` | 可选，默认 `25575` |
| `LOG_LEVEL` | 可选，`debug` / `info` / `warn` / `error`，默认 `info` |
| `MC_PROXY_PUBLIC_ORIGIN` | 可选，官方认证代理的公开 HTTPS 来源，例如 `https://minecraft.example.com` |

分别运行两次 `openssl rand -hex 32` 生成互不相同的 `ADMIN_KEY` 与 `RCON_PASSWORD`。参考 [.env.example](.env.example)，真实值只保存到 Makers 运行时变量中，修改变量后重新部署。不要写入前端 `config.js` 或 Git。

`config.js` 中的 `window.MVS_SITE` 仅包含公开版本、项目链接与 `publicStatusEnabled`。配置完整后可将 `publicStatusEnabled` 设为 `true` 并重新部署，显示公开状态卡；默认 `false`。这个开关控制首页展示，`/api/server-status` 仍是公开接口，设置 RCON 后返回玩家名与人数。需要完全停用公开状态接口时，移除 `cloud-functions/api/server-status.js` 后重新部署；后台同步缓存不受影响。

## 游戏服 RCON

默认游戏服关闭 RCON。停服后编辑持久游戏数据中的 `server.properties`，设置：

```properties
enable-rcon=true
rcon.port=25575
rcon.password=填写独立随机密码
```

随后重启游戏服。修改 RCON 设置需要重启；白名单、难度与网页日常操作即时生效。Docker 部署在需要跨容器连接时额外映射 `25575/TCP` 到受保护网络入口，服务端启动无需额外模组、Web 容器或重新构建镜像。

RCON 为明文协议。Makers 云函数需要能访问受保护的游戏服地址；游戏主机的 `127.0.0.1` 仅用于本机测试，云函数无法通过它连接另一台主机。网站 HTTPS 不加密 RCON 这一段连接。

## 管理功能

打开 `/admin/`，使用 `ADMIN_KEY` 登录：

| 功能 | 行为 |
| --- | --- |
| 玩家与白名单 | 查看在线名单、添加／移除白名单、踢出玩家 |
| 难度与游戏规则 | 设置难度、死亡保留物品、睡眠人数比例、生物破坏、昼夜／天气自然变化；修改后读回确认 |
| 日常管理 | 发送公告、修改主世界时间／天气、执行 `save-all flush` 保存世界 |
| 玩家救援 | 读取在线玩家维度与坐标，确认后传送至另一名在线玩家身边 |
| 封禁与解封 | 按玩家名封禁／解封，保留服务端原始封禁名单报告 |
| 结构定位 | 查询村庄、府邸、要塞等 12 类结构，显示目标坐标、水平距离与八方向 |

管理操作均采用固定指令及严格参数校验，不提供任意命令输入。RCON 连接按请求建立并关闭；修改超时不会自动重试，应刷新并检查游戏日志确认结果。保存世界不等同于创建备份。

当前命令与英文回复解析适配默认 Minecraft **26.3**。时间指令使用世界时钟，游戏规则使用 `keep_inventory`、`players_sleeping_percentage`、`mob_griefing`、`advance_time`、`advance_weather`。切换游戏版本或安装改写指令输出的模组时，需重新验证兼容性。

结构定位入口为 `/admin/#locate`，共享原有登录与权限。坐标为 ±29,999,984 范围内的整数：主世界 → 下界除以 8 后向下取整，下界 → 主世界乘以 8，超界时拒绝；末地不参与换算。距离与方向始终根据目标维度的搜索起点计算。要塞结果为要塞定位点，不能视为传送门方块精确坐标。结果不提供种子、不执行传送，也无法判断结构是否已探索或拆除；未返回高度时不把搜索用 Y=64 当作真实高度。

登录 Cookie 有效期为 24 小时，使用 HMAC 签名、HttpOnly、SameSite=Strict，HTTPS 下带 Secure。写操作验证同源 Origin 与 CSRF；轮换 `ADMIN_KEY` 使旧会话失效。社区版使用独立 Cookie 名称与签名域。退出只清除当前浏览器 Cookie，登录失败限制按云函数实例执行。

玩家头像通过公开玩家名从 Minotar 加载，失败时显示姓名缩写，不包含管理密钥、RCON 地址或页面来源。

## 可选状态缓存

`/api/server-status` 使用官方 `@edgeone/pages-blob` SDK，Blob 使用项目的托管存储上下文。首次访问及缓存过期时，在函数内执行 RCON `list` 并共享快照。成功和失败结果都缓存 5 分钟，跨实例条件写入减少重复探测；Blob 不可用时不绕过缓存连接游戏服。

首页开启状态卡后，可见期间每 30 秒以 `?cached=1` 只读快照，每 5 分钟允许完整采样，隐藏标签页暂停。管理员刷新在线名单时将已获得的数据发布到相同快照，较旧结果不能覆盖新样本。同步失败时后台仍显示成功取得的数据，并提示公开状态未同步。

公开响应只包含玩家名、人数、人数上限、状态及检查／成功更新时间，不包含白名单、位置、世界时间、RCON 地址、端口、密钥或原始错误。失败显示待刷新并保留旧数据；首次失败人数未知，不判断为游戏服离线。最近一次非空玩家名单单独记录，不能当成当前在线名单。无人访问时不采集，不设置定时任务。

## 可选官方认证代理

`/mc-proxy/*` 将请求转发到固定的 Mojang／Minecraft 服务，保留游戏服 `online-mode=true`。需要此功能时在 Makers 设置 `MC_PROXY_PUBLIC_ORIGIN=https://你的站点域名`，只填 HTTPS 来源，不含路径、参数、凭据或片段；缺失时代理返回 503。

云函数使用锁定版本的 `undici` 发起上游请求，防止平台的 fetch 重试认证写操作。请求不能指定转发目标；转发时移除 Cookie、访客 Authorization、转发头和其他敏感头，阻止上游重定向。只向客户端返回固定错误，不输出上游响应体中的调试错误或完整请求 URL。

Minecraft 26.3 的 authlib 使用服务发现。代理先取回官方发现文档，再改写固定官方来源的服务 URI，保留路径模板、纹理域名及不在支持列表内的服务。验证部署：

```sh
curl --fail-with-body https://你的站点域名/mc-proxy/discovery/minecraft/client
curl --fail-with-body https://你的站点域名/mc-proxy/services/publickeys
```

游戏服在 `.env` 设置 `MC_SERVICE_PROXY_URL=https://你的站点域名/mc-proxy`，然后重建容器（`docker compose up -d`）。运行脚本使用它设置：

```text
-Dminecraft.api.discovery.host=https://你的站点域名/mc-proxy/discovery/minecraft/client
```

ZIP 服务端也支持同一环境变量。代理不处理游戏 TCP、语音 UDP、启动器下载或完整 Microsoft 登录流程。Makers 出口需能访问官方服务；真正上线时应使用拥有 Java 版的账号验证连接。旧版兼容路由 `/mc-proxy/auth`、`account`、`session`、`services`、`profiles` 保留，过时上游可能不再可用。

## 本地验证与公开资源

```sh
cd web
npm ci
npm run build
cd ..
node --test tools/test_*.mjs
python3 -m unittest discover -s web -p 'test_*.py'
```

本地开发可在 `web/` 使用 EdgeOne CLI 的 `edgeone makers dev`。RCON 测试使用可丢弃的本机假服务器与测试密钥，不连接实际游戏服。

构建只发布逐文件白名单：`index.html`、`styles.css`、`app.js`、`config.js`、`assets/icon.svg`、`admin/index.html`、`admin/styles.css`、`admin/app.js`，另生成同一 SVG 内容的根路径 `favicon.svg`。不会复制 `.env`、文档、后台源码、依赖、Makers 配置，或 `assets/`／`admin/` 内未列出的文件；已列出资源及其父目录中的符号链接会被拒绝。没有吉祥物或社区活动素材。

云函数运行上限为 `cloudFunctions.maxDuration: 30`，RCON 自身限时 8 秒。结构化日志保留固定事件与安全状态字段，不记录密钥、Cookie、原始指令回复、玩家坐标、认证令牌、请求体或请求完整 URL。后台静态资源设置 CSP、no-store、nosniff 与 no-referrer。
