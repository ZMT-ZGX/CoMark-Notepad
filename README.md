# CoMark-Notepad

> CoMark = **Co**llaborative + **Mark**down

局域网实时协作记事本 + 文件共享 + 文件转 Markdown。一台电脑启动服务，同 WiFi 下的设备打开浏览器即可实时同步文字和文件，无需注册、无需云端。

## 核心特性

- **多 Pad 标签** — 多个独立记事本，支持新建、切换、长按删除
- **Patch 协同算法** — 基于 `diff-match-patch`，多设备同时编辑不丢内容（告别全量覆盖）
- **离线队列** — 断网时编辑进 localStorage（按 pad 隔离），重连后按序自动 flush
- **WS 心跳保活** — 30 秒 ping/pong + 强杀幽灵连接，内存不会泄漏
- **SQLite 全文搜索** — FTS5（trigram 分词）毫秒级搜索，匹配高亮片段
- **文件共享** — 拖拽 / 粘贴（⌘/Ctrl+V 上传剪贴板文件或截图）/ 点击上传（Busboy 流式，100MB 上限），支持中文文件名
- **文件转 Markdown** — PDF / DOCX / XLSX / PPTX / HTML / CSV / TXT / JSON / XML / YAML 及 JPG / PNG / GIF 一键转换
- **邀请制访问控制** — 三级权限（公开 / 受邀 / 管理员），HMAC Cookie 认证
- **密码保护** — 单个 Pad 可独立设密，WS 解锁 token 不走 URL
- **深色 / 浅色主题** — 跟随系统 / 手动切换，Apple 设计风格
- **移动端适配** — iOS Safari 兼容，左右滑切 Pad，AlloyFinger 手势
- **二维码快速连接** — 手机扫码即可加入
- **键盘快捷键** — `Ctrl/⌘ + K` 查看完整列表

## 键盘快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl/⌘ + N` | 新建 Pad |
| `Ctrl/⌘ + S` | 强制保存（跳过防抖） |
| `Ctrl/⌘ + E` | 导出当前 Pad 为 Markdown |
| `Ctrl/⌘ + I` | 打开邀请 / 兑换面板 |
| `Ctrl/⌘ + L` | 设置 / 修改 Pad 密码 |
| `Ctrl/⌘ + U` | 打开文件选择器 |
| `Ctrl/⌘ + F` | 搜索文件列表（非编辑区时） |
| `Ctrl/⌘ + Shift + F` | 全文搜索 Pad（SQLite FTS5） |
| `Ctrl/⌘ + 1-9` | 切换到第 N 个 Pad |
| `Ctrl/⌘ + ,` | 切换主题（auto / dark / light） |
| `Ctrl/⌘ + K` | 显示快捷键帮助 |
| `Esc` | 关闭所有弹窗 |

## 技术栈

| 层 | 选型 |
|---|------|
| 后端 | Node.js 18+ · Express 5 · TypeScript |
| 持久化 | better-sqlite3（WAL + busy_timeout）· FTS5 全文搜索 |
| 实时通信 | ws（WebSocket）· diff-match-patch patch 协同 |
| 文件上传 | Busboy multipart 流式 |
| 文件转换 | Worker Thread · mammoth · pdf-parse · read-excel-file · adm-zip · image-size · turndown |
| 认证 | HMAC-SHA256 httpOnly Cookie · 30 天 TTL |
| 运行时校验 | Zod v4 |
| 安全 | Helmet CSP · express-rate-limit · timing-safe 比较 |
| 前端 | 原生 HTML / CSS / ES Modules（零框架）· hotkeys-js · AlloyFinger |
| 测试 | Node.js test runner（72 个集成测试）|
| 工程化 | ESLint + Prettier + simple-git-hooks + GitHub Actions CI |

## 快速开始

```bash
git clone <repo-url>
cd collab-notepad
npm install
npm run dev
```

启动后访问：
- 本机：`http://localhost:8000`
- 局域网设备：`http://<本机IP>:8000`（网页端会生成二维码）

### 生产部署

```bash
# 直接
SESSION_SECRET=<64+字符随机密钥> \
PUBLIC_ORIGIN=https://yourdomain.com \
ADMIN_TOKEN=<管理员令牌> \
NODE_ENV=production \
npm run build && npm start

# Docker
cp .env.example .env
# 编辑 .env 填入 SESSION_SECRET (openssl rand -hex 32)
docker compose up -d
docker compose logs -f
```

数据持久化在 `./data` 目录（SQLite 数据库 + 上传文件）。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `8000` | 服务端口 |
| `SESSION_SECRET` | 随机生成（开发） | HMAC 签名密钥（**生产必填**）。开发模式下若未显式设置，会在 `DATA_DIR/.session_secret`（已被 `.gitignore` 忽略，权限 `0600`）持久化一个稳定密钥，使登录会话在重启后依然有效；生产环境必须用环境变量显式提供 |
| `SESSION_TOKEN_TTL_DAYS` | `30` | Token 有效期（天）|
| `PUBLIC_ORIGIN` | `http://localhost:PORT` | CSRF Origin 校验锚点 |
| `ADMIN_TOKEN` | 无 | 全局管理员令牌 |
| `NODE_ENV` | `development` | 设为 `production` 启用严格模式 |
| `DATA_DIR` | `./data` | 数据目录 |
| `FILE_TTL_HOURS` | `72` | 文件自动过期时间 |
| `CONVERT_MAX_BYTES` | `10485760` | 转 Markdown 的文件大小上限（10MB）|
| `CONVERT_TIMEOUT_MS` | `60000` | 转换超时（ms）|

## 协同模型

```
                client A                server                client B
                   │                      │                      │
   typing ──── patch_make ────► WS {patch}                       │
                   │             applyPatch ─┐                   │
                   │                  updatePadText             │
                   │                  broadcast {patch} ────────►│
                   │             ◄── patch-ack                  │
                   │                      │           patch_apply │
                   │                      │                update│
```

- **客户端**只发 diff patch（不传全文），带宽极省
- **服务端**串行应用 patch，保存后广播给房间其他客户端
- **接收方**用 `dmp.patch_apply` 合并，**光标位置不跳动**
- **断网时**patch 暂存 `localStorage`（key 按 padId 隔离），`onopen` 时按序发送

> ⚠️ 当前实现**没有 OT/CRDT**：两人在同一位置同时插入时，后到的 patch 可能失败，需要重新同步基线。Google Docs 级别的无冲突编辑需要引入 Yjs / Automerge。

## 访问控制模型

```
公开 Pad（ownerUserId=null）    →  任何已认证用户
私人 Pad（ownerUserId=X）       →  用户X + 被X邀请的用户
全局管理员（ADMIN_TOKEN）     →  所有区域的完全访问权
```

| 操作 | 公开 Pad | 私人 Pad | Admin |
|------|----------|----------|-------|
| 读取 / 编辑 | ✓ 所有认证用户 | ✓ 所有者+受邀 | ✓ |
| 上传 / 删除文件 | ✓ 任何已认证用户 ¹ | ✓ 所有者+受邀 | ✓ |
| 设置密码 / 删除 Pad | 仅 Admin | ✓ 所有者 | ✓ |

> **¹ 公开 Pad 的文件删除（有意为之）**：公开 Pad（`ownerUserId` 与 `creatorCode` 均为空）上，**任何已登录用户都可以删除 / 清空文件，不要求必须是上传者本人**。此设计针对「单人在本机使用」的场景——本应用的身份由浏览器自动注册，每次服务重启会使旧会话失效并产生一个全新身份，若严格按 owner 校验，用户将无法删除自己之前上传、但挂在旧身份下的文件。权衡如下：
> - **匿名用户**删除任何文件仍被拒绝（`DELETE /api/files/:id` 返回 401，批量清空返回 403）。
> - **私人 Pad**（有 `ownerUserId`）的删除 / 清空权限完全不变，仍仅限所有者、受邀者与管理员。
> - **多人 / 共享部署注意**：若把本服务部署给多人共用，公开 Pad 上任意登录用户可删他人文件。如需严格权限，请设置 `ADMIN_TOKEN`（见下「环境变量」）并在共享前评估此行为；当前版本默认保留此放宽以保障单人本地体验。

## API

### 认证
- `POST /api/auth/register` — 自动注册
- `POST /api/auth/verify` — 验证 Token
- `GET  /api/auth/me` — 当前用户信息
- `POST /api/auth/logout` — 撤销当前会话

### 邀请
- `POST   /api/invitations` — 生成邀请令牌
- `POST   /api/invitations/redeem` — 兑换邀请
- `DELETE /api/invitations/:token` — 删除令牌

### Pad
- `GET  /api/state` — 获取可访问的 Pads + 文件
- `GET  /api/search?q=<terms>` — FTS5 全文搜索（按用户可见范围过滤）
- `POST /api/pads` — 创建 Pad
- `PUT  /api/pads/:id/text` — 全量更新文本（HTTP 兜底）
- `DELETE /api/pads/:id` — 删除 Pad
- `PUT  /api/pads/:id/password` — 设置密码

### 文件
- `POST   /api/upload` — multipart 上传
- `GET    /api/files/:id` — 下载
- `DELETE /api/files/:id` — 删除
- `GET    /api/convert/capabilities` — 获取可转换格式
- `POST   /api/convert/:fileId` — 将已上传文件转为 Markdown

### WebSocket
连接：`ws://host:port/?pad=<padId>`（session token 通过 Cookie 自动携带；锁定的 pad 需要连接后第一时间发 `{ type: 'auth', padToken }` 消息）

**客户端 → 服务端**
- `{ type: 'patch', padId, data }` — 发送 diff patch

**服务端 → 客户端**
- `{ type: 'hello', wsId, padId, userId }` — 连接建立
- `{ type: 'patch', padId, data, textVersion, senderId }` — 远端 patch 广播
- `{ type: 'patch-ack', textVersion }` — 单个 patch 已成功应用
- `{ type: 'text-update', padId, text, textVersion }` — 全量文本（仅 HTTP 兜底时出现）
- `{ type: 'online-count', padId, count }` — 在线人数
- `{ type: 'file-added' | 'file-deleted', padId, ... }` — 文件事件
- `{ type: 'pad-created' | 'pad-updated' | 'pad-deleted', ... }` — Pad 事件

## 测试

```bash
npm test                  # 全部测试（72 个）
npm run typecheck         # TypeScript 严格检查
npm run lint              # ESLint
npm run test:e2e          # Playwright E2E（需先 npm run build）
```

## 项目结构

```
collab-notepad/
├── src/
│   ├── server.ts          # 启动入口（DI 组装、HTTP/WS、优雅关闭）
│   ├── app.ts             # Express 应用（中间件、/api/search）
│   ├── config.ts          # 环境变量 + 常量
│   ├── types.ts           # 核心类型 + WsMessage union
│   ├── auth/              # session.ts · password.ts
│   ├── middlewares/        # auth.ts · security.ts · errorHandler.ts
│   ├── routes/            # auth · pads · files · invitations · convert · health
│   ├── services/          # padService · fileService · inviteService · convertService
│   ├── db/                # sqlite.ts (含 FTS5 schema + 触发器) · pads · files · users · invitations
│   ├── store/             # DataStore facade
│   ├── validators/        # Zod schemas
│   ├── utils/             # crypto · auth · errors · file · logger
│   └── ws/                # connections · broadcast · index
├── public/
│   ├── index.html
│   ├── js/                # ES Modules（零框架）
│   │   ├── core.js        # state singleton
│   │   ├── text-sync.js   # patch 同步、离线队列、图片粘贴
│   │   ├── ws.js          # WS 客户端
│   │   ├── server.js      # HTTP API 客户端
│   │   ├── pads.js        # Pad 标签
│   │   ├── files.js       # 文件列表
│   │   ├── search.js      # FTS5 搜索 UI
│   │   ├── preview.js     # Markdown 预览 + TOC
│   │   ├── shortcuts.js   # 键盘快捷键
│   │   ├── invitation.js  # 邀请/兑换
│   │   ├── modals.js      # 弹窗
│   │   ├── export.js      # 导出 + beforeunload
│   │   ├── theme.js       # 主题切换
│   │   ├── qr.js          # 二维码
│   │   └── gestures.js    # 移动端手势
│   ├── vendor/
│   │   └── diff_match_patch.js   # 浏览器全局（从 node_modules 包装）
│   └── style.css
├── convert-worker.js      # Worker Thread 文件转换引擎
├── tests/                 # 集成测试（72 个）
│   ├── identity.test.js
│   ├── smoke.test.js
│   ├── convert.test.js
│   └── e2e/               # Playwright E2E
├── Dockerfile             # 多阶段生产镜像
├── docker-compose.yml
├── .env.example
└── data/                  # 运行时自动生成
```

## 已知限制

- **冲突合并** — 两人在同一位置同时插入时后到 patch 可能失败（无 OT/CRDT）
- **图片 base64 直接存 SQLite** — 简单但膨胀大（>2MB 自动拒绝）
- **没 OT/CRDT** — 重度并发编辑建议升级到 Yjs

## Changelog

### v1.1.0 (2026-07-05)

**Patch 协同 + 全文搜索 + 离线队列**

- **Patch 协同算法** — 引入 `diff-match-patch`，前端用 `lastSyncedText` 维护基准，WS 只发 patch；服务端 `padService.applyPatch` 应用后广播 patch；接收方用 `patch_apply` 合并，光标位置尽力保留
- **离线队列** — `localStorage` 按 pad 隔离（`patch-queue:${padId}`），断网编辑暂存；`onopen` 时按序 flush；`beforeunload` 捕捉最后一次未同步编辑
- **WS 心跳保活** — 已有 30s ping/pong 机制；客户端重连时先发 `{ type: 'auth', padToken }`（不再走 URL，避免日志泄露）
- **SQLite FTS5 全文搜索** — `pad_search` 虚拟表（trigram 分词）+ AI/AD/AU 触发器自动同步；`/api/search?q=...` 端点按 bm25 排序；用户访问范围过滤；`snippet()` 返回 `<mark>` 高亮片段
- **WAL + busy_timeout=5000** — 消除 99% SQLITE_BUSY 报错
- **离线横幅 UI** — `<div id="offline-banner">` 黄色固定顶栏
- **Markdown TOC** — preview 渲染后提取 h1-h3 生成悬浮目录，点击平滑滚动
- **Ctrl/⌘ + Shift + F 全文搜索** — header 搜索按钮 + 下拉结果
- **图片粘贴 → base64** — 编辑器 `paste` 拦截，>2MB 拒绝，存为 `![](data:...)` 插入文本
- **本地 vendor** — `diff-match-patch` 复制到 `public/vendor/`，避免外网依赖 + CSP 冲突
- **类型化** — `WsPatch` 加入 `WsMessage` union；`padService` 加 `applyPatch` 方法
- **代码审查修复** — 修复 5 项 Critical（broken imports / CSP / 访问控制 / pad 隔离 / patch_apply 校验）+ 4 项 Warning（CDN 404、searchSnippet 假 FTS5、searchSnippet 列索引、缺离线持久化）

### v1.1.1 (2026-07-07)

**代码审查加固（10 项）**

- **`padId` 兜底修正** — 删除/清理文件过滤改严格相等；默认查找 `|| 1` → `?? 1`
- **`DiffMatchPatch` 单例** — 前后端分别提升为 `padService` 类字段与 `getDmp()` 模块单例，减少 GC 压力
- **发送端影子时序** — `text-sync.js` 在 `ws.send()` 之后才更新 `lastSyncedText`，避免断连分叉
- **搜索高亮修复** — 服务端 `<mark>` 片段按 HTML 渲染，否则转义文本（修复失效且无 XSS）
- **WebSocket `maxPayload`** — 设置 2MB 上限，防超大帧耗尽内存
- **CSP 收紧** — `scriptSrc` 移除未使用的 `cdn.jsdelivr.net`
- **`/api/auth/verify` 补 `checkOrigin`** — 与 `/register` / `/logout` 一致
- **邀请 `maxUses` 原子强制** — 事务内「先条件递增再插授权」，超限额回滚并避免 orphan 授权
- **测试 72/72 全通过**（较 1.1.0 新增 4 个用例）

> 注：审查报告的首项「`::root` 拼写错误」经核验为误报，样式本就正常。

### v1.1.2 (2026-07-08)

**公开 Pad 文件删除权限放宽（有意为之）**

- 公开 Pad 上任意已登录用户可删除 / 清空文件，忽略 owner；匿名删除仍被拒；私人 Pad 权限不变
- 背景与多人部署的安全权衡见上方「访问控制模型」¹ 注释
- 其他修复：**上传大文件永久卡死**（`req.destroyed` 误判中断，改用 `!req.complete`）、**PDF 转 Markdown 全部失败**（pdf-parse v2 `PDFParse` 类迁移）、IPv6 私网识别补全、`SESSION_SECRET` 开发期持久化（`0600`）、`isPublicPad` 去重、粘贴上传文件/截图、hotkeys-js 容错、限流范围收窄、CSP 重新允许 cdn.jsdelivr.net（SRI）

完整历史见 [CHANGELOG.md](CHANGELOG.md)。

## License

MIT
