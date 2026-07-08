# Changelog

All notable changes to this project are documented in this file. Versions follow [Semantic Versioning](https://semver.org/).

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

### Test Coverage

- 72/72 测试全部通过
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
