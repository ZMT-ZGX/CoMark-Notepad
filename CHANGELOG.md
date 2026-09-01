# Changelog

All notable changes to this project are documented in this file. Versions follow [Semantic Versioning](https://semver.org/).

## [1.2.0] - 2026-09-01

### 协作手感与带宽 / 内存开销修复

1. **远端编辑不再把光标弹到文末** — `text-sync.js` 此前在应用远端权威正文时只 `ta.value = text`，浏览器会把 textarea 光标重置到末尾，对端每敲一个字本地光标就跳走。新增 `mapCaret()`：走一遍 diff，按「光标之前删除则回退、之前插入则前移」把旧偏移映射到新正文，并用 `setEditorText()` 统一所有写入点（`applyTextState` / `applyLoadedText` / `applyRemotePatch` / `ackInflight` / `mergeAndResync`）。patch 分支原有的 `setSelectionRange` 也从「按新长度截断」改为真正的偏移映射。
2. **远端编辑不再打断中文输入法** — 组合态期间（`compositionstart` → `compositionend`）绝不写 `textarea.value`，否则 IME 组合缓冲被销毁、正在拼的字丢失。远端正文暂存为 `pendingRemoteState(force)`，在 `compositionend` 提交后连同本地已提交文本一起 rebase。同时组合态期间**暂停发送**：此时发出的 patch 基于已过期的版本号必然被 nack，而其 HTTP 重试会覆盖掉刚收到的远端编辑。blur 作为 `compositionend` 未触发时的兜底。
3. **离线队列不再撑爆 localStorage 并静默丢数据** — 原实现每个 300ms 防抖周期追加一条、每条各存一份全量 `sentText`，50KB 文档断网两分钟即可产生约 20MB，远超 ~5MB 配额；`setItem` 抛错被 `catch {}` 吞掉，编辑静默丢失而「待同步」横幅仍显示。队列改为**塌缩成单条**（始终从已确认 shadow 直接 diff 到最新正文，与原来的链式队列等价但极小）；`state.setPatchQueue` 在配额失败时降级为只保留最新一条并 toast 提示，不再静默。
4. **每次编辑的广播从两份全文档降为一份** — `padService.applyPatch` 原来同时广播 `patch`（已含全量 `text`）和 `text-update`（又一份全量快照）。后者 100% 被客户端丢弃：`patch` 已把本地版本推到 N，快照的 `version <= textVersion` 守卫直接返回。删除重复广播，出向带宽与 JSON 序列化 CPU 减半；`patch` 帧保留 `data`（diff 很小）作为无权威正文时的兜底。
5. **元数据查询不再读取正文** — 新增 `db/pads.ts` 的 `findByIdMeta` / `findAllMeta` / `count` 与 store 的 `findAllPadMeta` / `countPads`。`/api/state`（每次 `pad-created` / `pad-updated` / `pad-deleted` 广播都会让所有客户端重打）与搜索鉴权原先 `SELECT *`，把每个 Pad 的最多 100KB 正文读进内存只为取几个字段。
6. **搜索路由减少查询与编译** — 每条结果由 `pads.findById`（整行）改为 `findByIdMeta`；`searchSnippet` 的两条 SQL 改为按数据库句柄缓存的 prepared statement（原先每条结果编译一次，20 条即 20 次）。
7. **`updateText` 不再回读整行** — 改用 `RETURNING text_version, <meta>`，只取标量列；调用方本来就持有刚写入的正文。
8. **堵住加锁 Pad 的连接数缺口（安全）** — 加锁 Pad 的 socket 要等首条 `auth` 消息（最长 1.5s）才进入 `connections.add()`，在此之前 `MAX_WS_CONNECTIONS` 与 `MAX_WS_CONNECTIONS_PER_IP` 都看不到它，可被无限堆叠。现在 `connection` 事件一开始就登记 pending 计数（全局 + 按 IP），`finalizeConnection` 时升级为正式连接，`close` 时统一释放；pending 连接不进 `padClients`，不会被广播 / 心跳扫到。
9. **`patch-ack` 版本号改用 `typeof === 'number'`** — 原先 `if (msg.textVersion)` 在版本为 0 时不生效。
10. **`state.padSync` 不再无限增长** — `seenOperations` 每 Pad 上限 1 万条；现在按 LRU 保留最近 5 个 Pad 的去重缓存（其余 Pad 的 shadow / 版本 / in-flight 状态保留，离线 diff 仍依赖它）。
11. **切回前台强制重同步** — 新增 `visibilitychange` 监听：页面重新可见且无待发送编辑时主动 `loadPadContent()`，修复移动端切后台再回来后持陈旧正文继续 diff 的问题。

### 有意不做的一项

- **FTS trigram 节流重建** — 触发器 `pad_au` 目前每次 patch 都同步全量重建索引。改为「脏标记 + 定时批量重建」需要 `DROP TRIGGER` 迁移（现有库上的 `CREATE TRIGGER IF NOT EXISTS` 不会替换旧触发器），且会引入搜索最终一致，与「写入后立即可搜」的现有测试契约冲突。收益（编辑路径 CPU）暂不抵风险，留待后续单独评估。

### 自托管部署优化

面向「部署到自己的服务器」的改造，形态为 **Docker Compose + Caddy 自动 HTTPS**（应用不直接暴露端口，Caddy 为唯一入口）。完整流程见 `docs/DEPLOYMENT.md`。

### 修复

1. **资源限制此前形同虚设** — `docker-compose.yml` 原用 `deploy.resources.limits`（512M / 1 CPU），该文件自身注释已说明其仅在 Swarm 模式或 `--compatibility` 下生效，标准 `docker compose up` **完全不应用**。改用标准 compose 真正生效的服务级 `mem_limit` / `cpus`。
2. **转换内存峰值与容器上限冲突（会 OOM）** — `MAX_CONCURRENT_CONVERTS = 3` 与 worker 堆 `512MB` 均为硬编码，峰值 1.5GB，远超 512M 限制，一转换即被 OOM kill。现改为环境变量可配（`CONVERT_MAX_CONCURRENT` / `CONVERT_WORKER_HEAP_MB`，默认值保持 3 / 512 以兼容既有行为），compose 按小机型调优为 2 × 256MB，并给出内存预算公式。
3. **启动配置告警从未触发** — `PUBLIC_ORIGIN` 有 `http://localhost:<port>` 兜底值，故 `if (isProduction && !PUBLIC_ORIGIN)` 恒为假，该告警是死代码。新增 `productionConfigWarnings()` 直接检查原始 env，并补充四类自托管高频误配告警（http 源导致 Secure Cookie 失效、`TRUST_PROXY_HOPS=0` 导致限流共用桶、`ADMIN_TOKEN` 未设、`SESSION_SECRET` 过短）。**只告警不抛出**：配置错误引发启动循环比配置降级更糟。
4. **`TRUST_PROXY_HOPS` 两处不一致** — `.env.example` 声明、`app.ts` 直读 `process.env`、而 `config.ts` 未导出。统一由 `config.ts` 解析并导出（`parseNonNegativeInt`，接受 0 = 无反代），`app.ts` 改为引用。
5. **健康检查全量加载** — `/api/health` 用 `db.pads.findAll()` 仅为取数量，每 30 秒把所有 Pad 正文（每个最多 100KB × 50）读进内存。改用 `COUNT(*)`；并为 `db.files` 补了 `count()`（原只有 `findAll()`）。
6. **日志敏感信息泄露面** — Pad 解锁 token 走 `X-Pad-Token` 头、会话走 cookie，任何打印请求对象的代码都会把长期凭证写进日志（自托管环境下常与数据目录同盘）。新增 pino `redact`，对 `cookie` / `authorization` / `x-pad-token` / `password` / `token` 脱敏为 `[REDACTED]`。

### 新增

7. **存活 / 就绪探针分离** — `/api/health` 为存活探针，**不碰数据库**（Docker 连续失败会重启容器，不能让繁忙的 SQLite checkpoint 误杀健康进程）；新增 `/api/health/ready` 为就绪探针，查库并返回 `pads` / `files`，库不可用时 503。
   > ⚠️ **契约变更**：`pads` / `files` 字段从 `/api/health` 移至 `/api/health/ready`。外部监控若读取这两个字段需改指就绪端点。
8. **访问日志增强** — 原仅记 `method / path / ip`。现改为在响应 `finish` 时记录，补充**状态码与耗时**，按级别分流（4xx warn、5xx error），并跳过健康检查请求（每 30 秒一次，否则刷屏）。
9. **容器安全加固** — `read_only: true` + `/tmp` tmpfs、`cap_drop: [ALL]`、`no-new-privileges:true`、`init: true`（回收僵尸进程并正确转发 SIGTERM）；应用不再发布宿主机端口。
10. **日志滚动** — json-file 驱动配 `max-size: 10m` / `max-file: 3`，防止日志无限增长占满磁盘。
11. **部署与运维脚本** — `scripts/deploy.sh`（备份 → 打回滚标签 → 构建 → 重启 → 等就绪，**失败自动回滚**）、`scripts/backup.sh`（经 SQLite backup API 取一致性快照 + 上传文件归档 + 保留期清理）、`scripts/sqlite-backup.js`。
    > 备份**不能**用 `cp store.db`：服务运行时库旁有 `store.db-wal`，直接拷贝主文件会拿到半个 checkpoint 的损坏数据。
12. **`.env.example` 补全** — 补齐 8 个代码已生效但未文档化的变量（`NODE_ENV`、`DATA_DIR`、`LOG_LEVEL`、`MAX_WS_CONNECTIONS`、`MAX_WS_CONNECTIONS_PER_IP`、`WS_PATCH_WINDOW_MS`、`MAX_WS_PATCHES_PER_WINDOW`、`TRUST_PROXY_HOPS`），并按用途分组注释。

### Test Coverage

- **75/75 测试通过**；`tsc --noEmit` 零错误；ESLint 零告警
- 新增「加锁 Pad 的未认证连接计入每 IP 上限」回归用例；既有 patch 广播用例补「每次编辑只产生一个广播帧」断言
- 健康检查用例由「只断言 `/api/health`」扩展为**同时校验存活与就绪两个端点**，并保留原有 `pads === 1` 断言（移至就绪端点）后补 `uptime` 与 `files` 断言——属补强而非削弱
- `scripts/backup.sh` / `scripts/deploy.sh` 通过 bash 语法校验（`bash -n`）、`scripts/sqlite-backup.js` 通过 `node --check`；`docker-compose.yml` 通过 YAML 解析校验

### 未验证项

- 运行环境无 Docker / shellcheck，故以下内容**仅通过静态校验，未经实机运行验证**：`docker-compose.yml` 实际启动、`read_only: true` 与该应用的兼容性、`Caddyfile` 配置、`deploy.sh` / `backup.sh` 的实际执行与回滚路径。
  首次部署时请先按 `docs/DEPLOYMENT.md` 第 3 节逐步验证；`read_only` 若导致启动失败，文档第 9 节已给出定位与处置方式。

---

## [1.1.3] - 2026-07-12

### Security Hardening（Pad unlock / 搜索 / 转换）

基于代码审查的安全加固与行为对齐：

1. **搜索片段 XSS 修复（Critical）** — FTS5 `snippet()` 不再用字面量 `<mark>` 包裹用户正文（用户可写入 `</mark>…` 绕过 escape-then-restore）。服务端改用私有区定界符 `U+E000` / `U+E001`；客户端先 `escapeHtml` 全文，再只把定界符还原为 `<mark>`。
2. **Unlock token 全面禁止 query 串** — `requirePadUnlock`、文件下载/上传、搜索、`/api/state` 只认 `X-Pad-Token` header。客户端下载/预览改为 `fetch + header + blob URL`；`beforeunload` 兜底写入改用 `fetch({ keepalive: true })` 带 `X-Pad-Token` 头（`sendBeacon` 无法带请求头，故弃用），body 超 60KB 时跳过，由按 pad 隔离的离线队列兜底（写 localStorage，重连补发）。
3. **多 token header** — `X-Pad-Token` 支持逗号分隔多个 unlock token；`extractPadTokens` / `hasValidUnlockToken` 在 search、state、download、upload、改密路径共用。
4. **搜索 + state 门禁** — 加锁 Pad 的正文/snippet 不出现在搜索结果中，除非请求携带该 Pad 的有效 unlock token；`/api/state` 同样隐藏加锁 Pad 的文件元数据。客户端搜索/state 自动附带全部已存 token；解锁成功后 `refreshPads()` 立即刷新文件列表。
5. **WS 写路径复检锁** — 建连时把 unlock token 存到 `ws.unlockToken`；每次 `applyPatch` 再校验，失效返回 `{ locked: true }` 并由服务端 `close(4403, 'Pad locked')`。`applyPatch` 统一返回结构体（`ok` / `notFound` / `denied` / `locked`），不再混用 `null`。
6. **`padId` 误归属收紧** — 服务层去掉 `file.padId ?? 1` 的强制默认，避免挂到错误 Pad；无 `padId` 的遗留/孤儿文件改回仅按 `canAccessFile` 鉴权显示（既不泄漏加锁 Pad 元数据，也不再误隐藏可访问文件）。加锁 Pad 的文件元数据在未携带有效 unlock token 前仍对 `/api/state` 不可见。
7. **`CONVERT_MAX_BYTES` 默认 100MB** — 与上传上限对齐（原 10MB）；客户端 `convertCapabilities.maxBytes` 与 README 同步。可用环境变量覆盖。

### Test Coverage

- 74/74 单元测试通过；`tsc --noEmit` 零错误

---

## [1.1.2] - 2026-07-08

### 公开 Pad 文件删除权限放宽（有意为之）

公开 Pad（`ownerUserId` 与 `creatorCode` 均为空）上，**任意已登录用户均可删除 / 清空文件，忽略 owner 匹配**；匿名删除仍被拒绝（单文件 401、批量 403）；私人 Pad 权限不变。

- **背景**：身份由浏览器自动注册，每次服务重启使旧会话失效并产生新身份，旧身份上传的文件因 owner 不匹配而无法被新身份删除。放宽后单人本地场景可正常管理自己的全部文件。
- **安全权衡**：该放宽对「共享 / 多人部署」会削弱文件访问控制（任意登录用户可删他人文件）。当前版本默认保留此行为以保障单人本地体验；严格模式请在共享前通过设置 `ADMIN_TOKEN` 并评估（详见 README「访问控制模型」）。
- 同步更新 `tests/identity.test.js` 断言：公开 Pad 上普通登录用户删 / 清空文件现预期为 200。

### 其他修复与改进

- **上传大文件永久卡死修复（严重）** — 几百 KB 以上的文件上传会永远停在「Uploading…」，服务端收完 body 却从不返回。根因：中断检测用 `req.on('close')` + `req.destroyed`，而 `req.destroyed` 在请求正常结束时也会变 `true`；较大的 multipart body 使 `close` 早于 busboy 的 `finish` 触发，被误判为中断 → 销毁正在写入的文件流 → busboy `finish` 里 `await fileWritePromise` 永不 settle → 请求悬挂。改用 `req.on('close')` + `!req.complete`（`req.complete` 为 `true` 表示 body 已完整接收，属正常结束）。已验证 800KB / 2.8MB PDF 上传返回 200 并完整落盘，真正的中途中断仍正确清理半成品；同时规避了已弃用的 `req.on('aborted')`。
- **pdf-parse v2 迁移（严重）** — 升级到 pdf-parse v2.4.5 后 **所有 PDF → Markdown 转换失败（HTTP 422）**：v2 移除了默认导出函数，改为 `PDFParse` 类。`convert-worker.js` 改用 `new PDFParse({ data })` → `getText()`，并在 `finally` 中 `destroy()` 释放资源。
- **IPv6 私网识别补全** — `security.ts` 的 `isPrivateIp` 在剥离 `::ffff:` 前缀前先去除 IPv6 方括号（`[::1]` / `[fd00::1]`），修复方括号形式 IPv6 主机被误判为公网导致 CSRF 403 / WS 4400。
- **`SESSION_SECRET` 开发期持久化** — 未显式设置时持久化到 `DATA_DIR/.session_secret`（已被 `.gitignore` 忽略，权限 `0600`），使会话在重启后有效；生产环境仍强制要求显式设置。
- **代码去重** — 提取 `isPublicPad(pad)` 辅助函数，`deleteFile` / `clearFiles` 复用；`clearFiles` 权限判断合并为单一 `canClear` 守卫。
- **粘贴上传文件** — `files.js` 新增全页 `paste` 监听：⌘/Ctrl+V 可上传剪贴板中的文件（访达/资源管理器复制的文件）或截图（自动命名 `pasted-<时间戳>[-N].<ext>`），复用拖拽的确认流程；剪贴板仅含文本、或焦点在正文且仅为图片时不拦截（后者仍由 `text-sync.js` 内嵌为 base64）。`index.html` 空状态提示同步为「Drag, paste, or click Upload」。
- **hotkeys-js 容错** — `shortcuts.js` 在 `hotkeys` 全局缺失时静默跳过，不再中断整条初始化链。
- **限流范围收窄** — 单文件删除移出专用删除限流（仅受通用限流保护），批量清空保留独立 `clearFilesLimiter`（max 5）。
- **CSP 调整** — `app.ts` `scriptSrc` 重新允许 `https://cdn.jsdelivr.net`（alloyfinger 经 CDN 加载且已配 SRI `integrity`）。
- **匿名删除统一 401** — `routes/files.ts` 对任意文件的匿名删除返回 401（原仅对无主文件）。

### 可靠投递状态机重构（每 Pad 隔离、单 in-flight）

将前端的协同同步模型从「全局 shadow + 多个并行未 ACK patch」改为 **每 Pad 一个 confirmed shadow + 一个 in-flight operation + 一个 pending target text**（`state.padSync[padId]`），彻底消除在全局数组与并行 patch 上反复补状态的脆弱性。修复 6 个可靠投递问题：

- **P1 并行 patch 串文** — `text-sync.js` 仅在 ACK 后才推进 shadow 并计算下一条；同一 shadow 上只允许一个 in-flight，避免 `""→"A"` 与 `""→"AB"` 并发时被服务端依次应用成 `AAB`。
- **P1 上锁 Pad 认证失败丢队列** — 离线入队不再提前推进 shadow；队列改为在认证完成的 `hello` 之后才 flush，invalid unlock token 时队列完整保留。
- **P1 切换 Pad 串号** — `switchPad` 在切换前先把旧 Pad 的 in-flight / 待发送文本折叠回其离线队列；每个 WS 实例记录所属 `padId`，断线重排只处理自己的 Pad，旧 socket 的 `onclose` 因实例检查直接返回，不会把旧 patch 串入新 Pad。
- **P1 旧 Pad HTTP 响应写新 Pad** — `requestToken` 改为每 Pad 单调递增、永不复位；409 合并路径捕获并贯穿原始 `padId` + `sync`，陈旧响应（来自旧 Pad）直接丢弃。
- **P2 旧 GET 覆盖新 WS** — `applyTextState` 增加版本守卫，版本低于当前确认的 GET 不再覆盖正文（防止 WS v11 先到、GET v10 后到导致持有 v10 却标记 v11）。
- **P2 图片 2MB 上限与 100k 字符服务端限制冲突** — 粘贴内嵌前按 base64 长度（>75KB）提前拦截并提示，新增 E2E 覆盖该边界（~60KB PNG 被拒、正文不变）。

### Test Coverage

- 74/74 单元测试 + 17 E2E 全部通过
- typecheck + lint 零错误

---

## [1.1.1] - 2026-07-07

### Code Review Hardening (10 项)

基于全量代码审查的修复与加固：

1. **`padId` 兜底模式修正** — 删除/清理文件时 `(f.padId || 1)` 改为严格相等 `(f.padId === padId)`；`fileService` / `db/files` / `db/sqlite` 的默认查找 `|| 1` → `?? 1`（仅在 `null`/`undefined` 时回退，避免有效 `padId` 被误默认）
2. **`DiffMatchPatch` 单例（后端）** — `padService` 提升为类字段并在构造函数初始化一次，不再每次 `applyPatch` 新建实例（减少 GC 压力）
3. **发送端 `lastSyncedText` 时序** — `text-sync.js` 将 `state.lastSyncedText = currentText` 移到 `ws.send()` 之后，避免断连时本地影子领先于服务端而产生内容分叉
4. **搜索高亮修复** — `search.js` 仅当存在服务端生成的 `<mark>` 片段时按 HTML 渲染，否则转义文本（修复高亮失效，且无 XSS 风险）
5. **WebSocket `maxPayload`** — `ws/index.ts` 设置 `maxPayload: JSON_BODY_LIMIT`（2MB），防止超大帧耗尽内存（WS 帧绕过 Express body 限制）
6. **CSP 收紧** — `app.ts` `scriptSrc` 移除未使用的 `cdn.jsdelivr.net` 放行，与「禁止 CDN 加载脚本」策略一致
7. **`/api/auth/verify` 补 `checkOrigin`** — 与 `/register` / `/logout` 保持一致，统一 CSRF 防御
8. **邀请 `maxUses` 原子强制（纵深防御）** — `db/invitations.addGrant` 改为事务内「先条件递增再插授权」，命中上限时回滚并抛 `INVITE_LIMIT_REACHED`；`inviteService.redeem` 转换为 `GoneError`，杜绝 orphan 授权行
9. **`DiffMatchPatch` 单例（前端）** — `text-sync.js` 提取模块级 `getDmp()` 单例，替换 4 处 `new window.diff_match_patch()`

> 注：审查中报告的首项「`::root` 选择器拼写错误」经核验为误报，`public/style.css` 实际已为 `:root`，全站样式正常，无需改动。

### Security Hardening（额外 3 项）

基于二次安全审查的补充修复：

10. **IPv6 ULA 私网识别补全** — `security.ts` 的 `isPrivateIp` 正则由 `/^fc[0-9a-f]/` 改为 `/^f[cd][0-9a-f]/`，同时覆盖 `fc00::/8` 与 `fd00::/8`（`fc00::/7`）。原写法遗漏了实际部署中最常用的 `fd00::/8`，导致使用该类局域网 IPv6 地址的客户端在 `PUBLIC_ORIGIN` 未显式配置时，CSRF 检查返回 403、WebSocket 握手被关闭（4400）。该函数在 HTTP `checkOrigin` 与 WS `isAllowedOrigin` 共用，一处修复两端生效
11. **`/register` 不再回显 session token** — 响应体由 `{ code, token, expiresInDays }` 改为 `{ code, expiresInDays }`。token 仅通过 HttpOnly cookie 下发，杜绝页面任意 XSS 通过响应体窃取凭据、使 HttpOnly 防护形同虚设的问题。对应测试已改为断言 `data.token === undefined`
12. **`/logout` 撤销前校验签名** — 原实现对任意 `x-session-token` 字符串直接写入 `revoked_tokens` 表，攻击者可借此灌表造成存储膨胀（DoS）。现对 cookie 与 header 两路 token 均先经 `verifySessionToken` 验签，仅结构合法且签名有效时才撤销

### Test Coverage

- 72/72 测试全部通过（较 1.1.0 新增 4 个用例，含 WS patch 速率限制、并发 patch 等；`identity.test.js` 强化 token 不回显断言）
- 修复后 typecheck + lint 零错误

---

## [1.1.0] - 2026-07-05

### Patch-based Collaborative Editing

告别全量文本广播。引入 [diff-match-patch](https://github.com/google/diff-match-patch) 实现真正的并发安全同步。

- **客户端**维护 `state.lastSyncedText` 作为 patch 计算基准；输入时通过 `dmp.patch_make` 生成 patch，**只发送 patch（带宽节省 90%+）**
- **服务端** `padService.applyPatch()` 从 DB 读当前文本 → `dmp.patch_apply()` → 保存 → 广播 `{ type: 'patch', data }`；接受/拒绝取决于 `results` 数组是否有 `false`
- **接收方**用 `patch_apply` 合并到本地 textarea，光标位置尽力保留（截断到 `newText.length`）
- **WS 协议**新增消息类型 `patch` / `patch-ack`；广播 payload 加 `senderId` 防回环
- **回退路径** WS 不可用时仍走 HTTP `PUT /api/pads/:id/text`（保留全量上传兜底）

### Offline Resilience

- **离线队列** 断网时 patch 暂存 `localStorage`，key 按 `padId` 隔离（`patch-queue:${padId}`）
- **`onopen` flush** 重连后按序发送队列
- **beforeunload 兜底** 关闭页面前如有未同步编辑，强制入队
- **离线横幅** `<div id="offline-banner">` 黄色固定顶栏，状态可视化

### SQLite Full-Text Search (FTS5)

- **`pad_search` 虚拟表** trigram 分词，列：`id UNINDEXED`, `title`, `content`
- **3 个触发器** `pad_ai` / `pad_ad` / `pad_au` 自动同步索引（零代码侵入）
- **`/api/search?q=...`** 端点：分词 → 短语包裹 → AND 拼接 → `MATCH` → `bm25` 排序
- **访问控制** 结果按 `padService.canAccessPad()` 过滤（私有 pad 对非授权用户不可见）
- **高亮片段** `snippet(pad_search, 2, '<mark>', '</mark>', '…', 32)` 函数式返回
- **WAL + busy_timeout=5000** 消除 99% SQLITE_BUSY

### Experience Polish

- **Markdown TOC** preview 渲染后自动提取 h1-h3，右侧悬浮目录，点击平滑滚动
- **Ctrl/⌘ + Shift + F** 全文搜索快捷键，header 搜索图标 + 下拉结果
- **图片粘贴** textarea 拦截 `paste` 事件，>2MB 拒绝，自动转 base64 插入为 `![](data:...)`
- **本地 vendor** `diff-match-patch` 复制到 `public/vendor/`，避免外网 CDN 依赖 + CSP 冲突
- **暗黑模式 CSS 兜底** `@media (prefers-color-scheme: dark)` 纯 CSS fallback
- **WS unlock token 移出 URL** 改用首条消息 `{ type: 'auth', padToken }`，避免代理/服务器 access log 泄露
- **WS padToken 鉴权** 加超时 1.5s；socket 关闭自动清除 timer

### Code Review Fixes

5 项 Critical 修复：

1. **broken imports** `pads.js` / `shortcuts.js` 仍从 `ws.js` 导入已下沉的 `sendTextNow` / `applyTextState` → 改从 `text-sync.js` 导入
2. **CSP 不允许 cdnjs** → 把 `diff-match-patch` 包装为 `public/vendor/diff_match_patch.js` 自带
3. **`/api/search` 无访问控制** → 用 `db.pads.findById(r.id)` 拿完整 pad 走 `canAccessPad()` 过滤
4. **offline queue 未 pad 隔离** → localStorage key 改为 `patch-queue:${padId}`
5. **`patch_apply` 结果未校验** → 服务端/客户端都检查 `results.some(r => !r)` 失败则拒绝/回退

4 项 Warning 修复：

- CDN 404（`text/` 路径错误）→ 改 cdnjs
- `searchSnippet` 假 FTS5（直接 substr）→ 真正用 FTS5 `snippet()`
- `searchSnippet` 列索引错（1=空 title）→ 改为 2（content）
- offline queue 缺持久化 → localStorage getter/setter + beforeunload 兜底

### Misc

- **类型化** `WsPatch` 加入 `WsMessage` union，含 `senderId: string | null`
- **logger** `padService.applyPatch` 4 种失败模式分别 `logger.warn`（不再静默返回 null）
- **vendor 静态服务** `app.use('/vendor', ...)` 暴露给浏览器

### Test Coverage

- 68/68 测试全部通过（+2 来自新 FTS5 路径）
- 修复后 typecheck + lint 零错误

---

## [1.0.2] - 2026-06-27

### Six-Phase Refactor

按 `CoMark-Notepad优化方案utl版.md` 完成全量架构升级，从单文件 `server.js` 迁移至模块化分层架构。

#### Phase 1 — 服务端模块化拆分
`server.js` 单文件 → `src/` 下 43 个 TypeScript 模块（routes / middlewares / ws / utils / auth / store / services / validators / db）

#### Phase 2 — 数据层抽象 + Zod 运行时校验
- `DataStore` facade 统一 26 个方法接口
- 9 个 Zod Schema 覆盖所有写操作路由
- `z.infer<>` 自动推导 TS 类型

#### Phase 3 — 前端模块化
`public/app.js` 单文件 → `public/js/` 下 10 个 ES Module 文件

#### Phase 4 — TypeScript 渐进式迁移
- 全部 `.js` → `.ts`
- `strict: true`
- Source Map 可用
- 构建产物 ~768KB

#### Phase 5 — SQLite 替换 JSON 存储
- `better-sqlite3` WAL 模式
- 外键约束 + CASCADE 删除
- 9 个索引
- JSON→SQLite 幂等迁移 + 自动备份

#### Phase 6 — 工程化与质量
- ESLint + Prettier + simple-git-hooks + GitHub Actions CI
- Docker 多阶段构建优化（非 root + 无构建工具）

### Security Hardening (preserved)

- HMAC-SHA256 / scrypt / `timingSafeEqual` / `SameSite=Strict` / Rate Limit / Origin 校验全部保留

### Code Review Fixes

- CI YAML 去重
- `||` → `??` mapper 修复
- `access_grants` 外键约束
- `errorHandler` null guard
- IJSONStore 接口对齐
- Pad ID AUTOINCREMENT
- 回滚免责声明

---

## [1.0.1] - 2026-06-26

### UTL 分层重构

按照 `CoMark-Notepad优化方案utl版.md` 完成全量架构升级，从单文件 `server.js` 迁移至模块化分层架构。

#### 新增目录结构

```
src/
├── server.js          # 入口：DI 组装、HTTP/WS 启动、优雅关闭
├── app.js             # Express 实例、全局中间件挂载
├── config.js          # 环境变量与全局常量
├── utils/             # 无状态纯函数工具层
├── middlewares/        # 全局/路由级中间件
├── auth/              # 身份认证与鉴权
├── db/                # 数据访问层 (Repository 模式)
├── services/          # 核心业务逻辑层
├── ws/                # WebSocket 实时协作
└── routes/            # HTTP 接口层 (薄控制器)
```

#### 核心架构改进

- **全局错误处理**：Service 层统一抛出 `AppError` 体系异常，Route 层 `next(e)` 透传，`errorHandler` 中间件统一映射 HTTP 状态码
- **纯业务层解耦**：Service 方法签名不接收 `req`/`res`，仅接收纯数据参数 (`userId`, `isAdmin`, `padId` 等)，可脱离 HTTP 环境独立测试
- **防抖 + 原子双轨写入**：`store.js` 高频更新用 `save()` 防抖，关键操作用 `flush()` 原子写入，杜绝 JSON 文件损坏
- **Token 撤销闭环**：`revokeToken` 使用 `flush()` 立即持久化，消除 200ms 防抖窗口内的宕机丢失风险
- **循环依赖打破**：提取 `db/revokedTokens.js` 中间模块，消除 `auth/session.js ↔ db/store.js` 循环引用
- **WebSocket padToken 鉴权**：加密 Pad 的 WS 连接必须持有有效 unlock token

### Code Review 修复 (7 项)

#### 路由层净化

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| 路由层 `service.db.*` 穿透 | 11 处 | **0 处** |
| 路由层 `broadcast` 直接调用 | 1 处 | **0 处** |
| 路由层 `res.status()` 硬编码 | 25 处 | **2 处** (sendFile 回调例外) |
| `convert.js` 错误字符串映射 | 6 行 | **0 行** (Service 直抛正确 statusCode) |
| `pads.js` password 路由业务逻辑 | ~20 行 | **3 行** (移入 padService) |

#### 具体修复

1. **`requirePadUnlock` 中间件化** — 提取 `security.js` 工厂中间件，消除 7 处 pad lock 重复检查
2. **Service 层新增 getter 方法** — `padService.getPadById()`、`fileService.getFileById()`、`convertService.getFileById()`，路由层不再穿透 db
3. **`padService.updateText()`** — 封装 db 写入 + broadcast，路由层不再直接操作数据
4. **`padService.setPassword()`** — 新增 `unlockToken` 参数，支持 unlock token 或 current password 双认证，自动区分 401/403
5. **`convertService` 错误类型修正** — 新增 `ServiceUnavailableError`(503)、`RequestTimeoutError`(504)，415/422 使用精确 `AppError` 构造
6. **路由层统一 `throw AppError`** — `invitations.js`、`auth.js`、`pads.js`、`files.js` 全部改用 `throw UnauthorizedError/BadRequestError` 替代 `res.status()`
7. **`headersSent` 防御** — `fileService.upload` 和 upload 路由 catch 块添加 `res.headersSent` 保护，防止流式上传中途断开导致进程崩溃

### Docker 修复

- `Dockerfile` 适配 `src/` 目录结构：`COPY src/ ./src/`、`CMD ["node", "src/server.js"]`

### 测试

- 66/66 测试全部通过
- 循环依赖检测 (madge)：仅 `ws/index.js` 误报，实际无循环

---

## [1.0.0] - 2026-06-15

Initial release.

- LAN real-time collaborative notepad with WebSocket sync
- File upload/sharing with MIME type detection
- Pad password protection with unlock token mechanism
- Invitation system for access control
- File-to-Markdown conversion (PDF/DOCX/XLSX/PPTX/images/HTML/CSV)
- Dark/light theme support
- Mobile-responsive UI
- Docker deployment support
