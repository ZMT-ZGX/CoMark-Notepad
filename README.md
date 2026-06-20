# Collab Notepad

局域网实时协作记事本 + 文件共享。一台电脑启动服务，同 WiFi 下的设备打开浏览器即可实时同步文字和文件。

## 功能

- **多 Pad 标签** — 多个独立记事本，支持新建、切换、长按删除
- **实时文本同步** — 多设备同时编辑，300ms 防抖广播
- **文件共享** — 拖拽上传文件（Busboy 流式，100MB 上限），支持中文文件名
- **邀请制访问控制** — 三级权限体系（公开 / 受邀 / 管理员），HMAC Cookie 认证
- **密码保护** — 可对单个 Pad 设置密码
- **深色/浅色主题** — 跟随系统 / 手动切换，Apple 设计风格
- **移动端适配** — iOS Safari 兼容，触摸交互优化，双行 Header 布局
- **二维码快速连接** — 手机扫码即可加入

## 技术栈

| 层 | 选型 |
|---|------|
| 后端 | Node.js + Express 5 |
| 实时通信 | WebSocket (ws) + 30s 心跳 |
| 持久化 | JSON 文件（200ms 防抖写入）|
| 文件存储 | Busboy multipart 流式上传 |
| 认证 | HMAC-SHA256 httpOnly Cookie |
| 安全 | Helmet CSP + express-rate-limit |
| 前端 | 原生 HTML/CSS/JS（零框架）|
| 测试 | Node.js test runner（34 个集成测试）|

## 快速开始

```bash
git clone <repo-url>
cd collab-notepad
npm install
node server.js
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

### 生产部署

```bash
SESSION_SECRET=<64+字符随机密钥> \
PUBLIC_ORIGIN=https://yourdomain.com \
ADMIN_TOKEN=<管理员令牌> \
NODE_ENV=production \
node server.js
```

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

### 邀请
- `POST /api/invite` — 生成邀请令牌
- `POST /api/invite/redeem` — 兑换邀请
- `DELETE /api/invite/:token` — 删除令牌

### Pad
- `GET /api/state` — 获取可访问的 Pads + 文件
- `POST /api/pads` — 创建 Pad
- `PUT /api/pads/:id` — 更新文本（广播）
- `DELETE /api/pads/:id` — 删除 Pad
- `PUT /api/pads/:id/password` — 设置密码

### 文件
- `POST /api/upload` — multipart 上传
- `GET /api/files/:id` — 下载
- `DELETE /api/files/:id` — 删除

### WebSocket
连接：`ws://host:port/?pad=<padId>&token=<sessionToken>`

消息类型：`text-update` / `file-added` / `file-deleted` / `pad-created` / `pad-deleted` / `online-count`

## 测试

```bash
npm test
```

## 项目结构

```
collab-notepad/
├── server.js         # Express + WebSocket + Auth + API
├── public/
│   ├── index.html    # 多标签 + 邀请模态框
│   ├── app.js        # 文本/文件/主题/邀请/认证
│   └── style.css     # Apple 设计语言 CSS + 移动端
├── tests/
│   ├── smoke.test.js     # 核心功能测试
│   └── identity.test.js  # 认证/安全测试
└── data/             # 运行时自动生成
```

## License

MIT
