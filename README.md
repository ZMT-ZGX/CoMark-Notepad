# CoMark-Notepad

(CoMark means "Collaborative + Markdown")局域网实时协作记事本 + 文件共享 + 文件转.md。一台电脑启动服务，同 WiFi 下的设备打开浏览器即可实时同步文字和文件。

## 功能

- **多 Pad 标签** — 多个独立记事本，支持新建、切换、长按删除
- **实时文本同步** — 多设备同时编辑，300ms 防抖广播
- **文件共享** — 拖拽上传文件（Busboy 流式，100MB 上限），支持中文文件名
- **文件格式转 Markdown** — 支持 PDF/DOCX/XLSX/PPTX/HTML/CSV/TXT/JSON/XML/YAML 及 JPG/PNG/GIF 图片元数据等一键转换
- **邀请制访问控制** — 三级权限体系（公开 / 受邀 / 管理员），HMAC Cookie 认证
- **密码保护** — 可对单个 Pad 设置密码
- **深色/浅色主题** — 跟随系统 / 手动切换，Apple 设计风格
- **移动端适配** — iOS Safari 兼容，触摸交互优化，双行 Header 布局
- **二维码快速连接** — 手机扫码即可加入

## 技术栈

| 层 | 选型 |
|---|------|
| 后端 | Node.js + Express 5 (TypeScript) |
| 实时通信 | WebSocket (ws) + 30s 心跳 |
| 持久化 | SQLite (better-sqlite3, WAL 模式) |
| 运行时校验 | Zod v4 |
| 文件存储 | Busboy multipart 流式上传 |
| 认证 | HMAC-SHA256 httpOnly Cookie |
| 安全 | Helmet CSP + express-rate-limit |
| 前端 | 原生 HTML/CSS/JS（零框架，ES Modules）|
| 文件转换 | Worker Thread + mammoth/pdf-parse/read-excel-file/adm-zip/image-size/turndown |
| 测试 | Node.js test runner（66 个集成测试）|
| 工程化 | ESLint + Prettier + simple-git-hooks + GitHub Actions CI |

## 快速开始

```bash
git clone <repo-url>
cd CoMark-Notepad
npm install
npm run dev
```

启动后访问：
- 本机：`http://localhost:8000`
- 局域网设备：`http://<本机IP>:8000`（终端会打印二维码）

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8000` | 服务端口 |
| `SESSION_SECRET` | 随机生成（开发） | HMAC 签名密钥（生产必填） |
| `SESSION_TOKEN_TTL_DAYS` | `30` | Token 有效期（天） |
| `PUBLIC_ORIGIN` | `http://localhost:PORT` | CSRF Origin 校验 |
| `ADMIN_TOKEN` | 无 | 全局管理员令牌 |
| `NODE_ENV` | `development` | 设为 `production` 启用严格模式 |
| `DATA_DIR` | `./data` | 数据目录 |
| `FILE_TTL_HOURS` | `72` | 文件自动过期时间 |
| `CONVERT_MAX_BYTES` | `10485760` | 转换 Markdown 的文件大小上限（10MB）|
| `CONVERT_TIMEOUT_MS` | `60000` | 转换超时（ms）|

### 生产部署

```bash
SESSION_SECRET=<64+字符随机密钥> \
PUBLIC_ORIGIN=https://yourdomain.com \
ADMIN_TOKEN=<管理员令牌> \
NODE_ENV=production \
npm start
```

### Docker 部署

```bash
# 1. 复制环境变量模板并编辑
cp .env.example .env
# 生成 SESSION_SECRET: openssl rand -hex 32

# 2. 启动
docker compose up -d

# 3. 查看日志
docker compose logs -f
```

数据持久化在 `./data` 目录（SQLite 数据库 + 上传文件）。

> ⚠️ **SQLite 回滚警告**：从 SQLite 回滚到 JSON 存储将导致自迁移后的所有增量数据（新 Pad、新文件、新邀请）丢失。此操作仅在灾难恢复时使用，日常请勿执行。迁移前会自动备份 `store.json.backup.<timestamp>`。

## 访问控制模型

```
公开区（ownerUserId=null）    →  任何已认证用户
受邀区（ownerUserId=X）       →  用户X + 被X邀请的用户
全局管理员（ADMIN_TOKEN）     →  所有区域的完全访问权
```

| 操作 | 公开 Pad | 私人 Pad | Admin |
|------|----------|----------|-------|
| 读取/编辑 | ✓ 所有认证用户 | ✓ 所有者+受邀 | ✓ |
| 上传/删除文件 | ✓ Pad 创建者 | ✓ 所有者+受邀 | ✓ |
| 设置密码/删除 | ✓ Pad 创建者 | ✓ 所有者 | ✓ |

## API

### 认证
- `POST /api/auth/register` — 自动注册
- `POST /api/auth/verify` — 验证 Token
- `GET /api/auth/me` — 当前用户信息
- `POST /api/auth/logout` — 撤销当前会话

### 邀请
- `POST /api/invitations` — 生成邀请令牌
- `POST /api/invitations/redeem` — 兑换邀请
- `DELETE /api/invitations/:token` — 删除令牌

### Pad
- `GET /api/state` — 获取可访问的 Pads + 文件
- `POST /api/pads` — 创建 Pad
- `PUT /api/pads/:id/text` — 更新文本（广播）
- `DELETE /api/pads/:id` — 删除 Pad
- `PUT /api/pads/:id/password` — 设置密码

### 文件
- `POST /api/upload` — multipart 上传
- `GET /api/files/:id` — 下载
- `DELETE /api/files/:id` — 删除
- `GET /api/convert/capabilities` — 获取可转换格式、大小限制和功能开关
- `POST /api/convert/:fileId` — 将已上传文件转为 Markdown

### WebSocket
连接：`ws://host:port/?pad=<padId>`（session token 通过 Cookie 自动携带）

消息类型：`text-update` / `file-added` / `file-deleted` / `pad-created` / `pad-deleted` / `online-count`

## 测试

```bash
npm test
```

## 项目结构

```
CoMark-Notepad/
├── src/
│   ├── server.ts          # 启动入口
│   ├── app.ts             # Express 应用配置
│   ├── config.ts          # 环境变量 & 常量
│   ├── types.ts           # 核心类型定义
│   ├── auth/              # 认证 (session/password)
│   ├── middlewares/        # 中间件 (auth/security/validate/errorHandler)
│   ├── routes/            # API 路由 (auth/pads/files/invitations/convert/health)
│   ├── services/          # 业务逻辑 (padService/fileService/inviteService/convertService)
│   ├── db/                # 数据层 (SQLite + pads/files/users/invitations)
│   ├── store/             # DataStore facade
│   ├── validators/        # Zod Schema
│   ├── utils/             # 工具 (crypto/auth/errors/file/logger)
│   └── ws/                # WebSocket (connections/broadcast)
├── public/
│   ├── index.html
│   ├── js/                # ES Modules (core/server/ws/pads/files/theme/invitation/modals)
│   └── style.css
├── convert-worker.js      # Worker Thread 文件转换引擎
├── tests/                 # 集成测试 (66 个)
├── Dockerfile             # 多阶段生产镜像
├── docker-compose.yml
├── .env.example           # 环境变量模板
└── data/                  # 运行时自动生成 (SQLite + 上传文件)
```

## Changelog

### v1.1.0 (2026-06-27)

**六阶段全面重构 + 代码审查修复**

- **Phase 1 — 服务端模块化拆分**: `server.js` 单文件 → `src/` 下 43 个 TypeScript 模块（routes/middlewares/ws/utils/auth/store/services/validators/db）
- **Phase 2 — 数据层抽象 + Zod 运行时校验**: DataStore facade 统一 26 个方法接口；9 个 Zod Schema 覆盖所有写操作路由；`z.infer<>` 自动推导 TS 类型
- **Phase 3 — 前端模块化**: `public/app.js` → `public/js/` 下 8 个 ES Module 文件（core/server/ws/pads/files/theme/invitation/modals）
- **Phase 4 — TypeScript 渐进式迁移**: 全部 `.js` → `.ts`；`strict: true`；Source Map 可用；构建产物 768KB
- **Phase 5 — SQLite 替换 JSON 存储**: `better-sqlite3` WAL 模式；外键约束 + CASCADE 删除；9 个索引；JSON→SQLite 幂等迁移 + 自动备份
- **Phase 6 — 工程化与质量**: ESLint + Prettier + simple-git-hooks + GitHub Actions CI；Docker 多阶段构建优化（非 root + 无构建工具）
- **安全复核**: HMAC-SHA256 / scrypt / timingSafeEqual / SameSite=Strict / Rate Limit / Origin 校验全部保留
- **代码审查修复**: CI YAML 去重、`||` → `??` mapper 修复、access_grants 外键约束、errorHandler null guard、IJSONStore 接口对齐、Pad ID AUTOINCREMENT、回滚免责声明

### v1.0.1 (2026-06-26)

- UTL 分层重构（Utils → Types → Logic）
- 前端移动端适配 + 双行 Header
- 修复上传超限未处理异常、convert 锁竞态、debounce 文本同步竞态

### v1.0.0

- 初始发布：多 Pad 标签 + 实时同步 + 文件共享 + 邀请制访问控制 + 密码保护 + 主题切换 + 二维码连接

## License

MIT
