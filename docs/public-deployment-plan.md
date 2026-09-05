# 公网部署 · 写权限控制改造

> 状态：**已实现**（S1–S8 完成，S9 加固项与腾讯云部署清单见末尾）
> 目标场景：腾讯云公网部署 · 5 人以内远程团队 · 陌生人可读、持口令/受信任才可写

## 1. 已实现的方案

### 权限模型（四层）

| 层级 | 获得方式 | 有效期 | 权限 |
|------|---------|--------|------|
| 访客 Reader | 打开网站自动注册 | 会话期 | 读有权限的 Pad、下载文件、搜索、解锁 Pad 密码 |
| 持令写 Writer | 输入口令 | 7 天（滑动续期） | 全部写操作 |
| 信任成员 Trusted | 管理员授予 | 永久（可撤销） | 全部写操作，无需口令 |
| 管理员 Admin | `X-Admin-Token` 请求头 | — | 以上全部 + 成员管理 |

- **信任成员白名单**替代了原计划的「永久后门口令」：同样不用再输口令，但按人可撤销、可审计、无共享密钥泄露风险。
- **滑动续期**：每次写操作若剩余有效期 < 5 天则续满 7 天，正常使用永不过期。
- **`POST /api/pads/:id/unlock` 归类为读**：只读用户可解锁查看加密 Pad，否则语义矛盾。

### 数据层

- 新增 `write_grants(user_code PK, source, granted_at, expires_at, last_used_at, granted_by)` 表，授权绑定 user_code（非 cookie），可查可撤销。
- `users` 表新增 `display_name`（昵称）。
- **Pad #1 弃用**：不再播种公开 Pad #1（`seedDefaultPad` 移除）。全新部署以零 Pad 启动；新建 Pad 默认私有（归属创建者）。旧库若仍有公开 Pad #1，可在成员管理中删除。

### 写路径封堵（13 处）

| # | 路径 | 位置 |
|---|------|------|
| 1 | `POST /api/upload` | `src/routes/index.ts`（app 级，单独挂载） |
| 2-3 | `DELETE /api/files/:id`、`DELETE /api/files` | `src/routes/files.ts` |
| 4-8 | `PUT/POST /:id/text`、`POST /`、`POST /:id/password`、`DELETE /:id` | `src/routes/pads.ts` |
| 9-11 | `POST /`、`POST /redeem`、`DELETE /:token` | `src/routes/invitations.ts` |
| 12 | `POST /:fileId` | `src/routes/convert.ts` |
| 13 | WS `{type:'patch'}` | `src/ws/index.ts`（每次 patch 复检，失效 4405） |

回归测试 `tests/write-access.test.js` 逐条覆盖：open 模式不误拦、gated 模式 12 条 HTTP 全 403、WS 4405、口令兑换、admin 授予/撤销、主动释放、成员列表鉴权、只读路径开放、昵称设置。

### 关键设计取舍

- **`WRITE_ACCESS_MODE` 默认 `open`**：LAN/单用户场景零配置不变；公网部署显式设 `gated`。生产环境启动自检会在 `open` 模式下告警（与 `PUBLIC_ORIGIN`、`TRUST_PROXY_HOPS` 等既有告警一致）。
- **Admin 无 session 也放行**：`status()` 先判 `isAdminUser` 再判 `userId`，否则管理员无法创建首个公开 Pad 或授予首个信任成员。
- **WS 不支持 admin 绕过**：浏览器无法在 WS 握手设自定义头，强行加 admin 握手会引入长生命周期凭据传输。管理员需编辑时，给自己授予信任成员即可（永久、可撤销）。
- **口令常量时间比对**：复用 `src/middlewares/auth.ts:38-45` 的 `timingSafeEqual` 模式，不可暴力枚举。

## 2. 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `WRITE_ACCESS_MODE` | `open` | `open` \| `gated`，公网必须 `gated` |
| `WRITE_PASSPHRASES` | 无 | `口令[:天数]`，逗号分隔；`:0` 用默认 TTL |
| `WRITE_GRANT_TTL_DAYS` | `7` | 口令授予的有效天数 |
| `WRITE_GRANT_RENEW_THRESHOLD_DAYS` | `5` | 剩余少于此天数自动续满 |
| `ADMIN_TOKEN` | 无 | 管理员令牌，成员管理用 |

## 3. 腾讯云部署清单

### 3.1 域名备案（最容易卡住）

腾讯云**国内服务器 + 自定义域名 = 必须 ICP 备案**（1–20 工作日）。无备案域名时：

- **香港/新加坡轻量服务器**（免备案，延迟 30-60ms）— 务实选择
- 国内服务器 + 已备案域名 — 延迟最低（20-40ms）

Caddy 自动 HTTPS 需要域名，直接用 IP 会与 Secure Cookie 冲突，不推荐。

### 3.2 配置四件套（必填）

```bash
NODE_ENV=production
SESSION_SECRET=<openssl rand -hex 32>   # 必须稳定，否则每次重启全员掉线
PUBLIC_ORIGIN=https://你的域名
TRUST_PROXY_HOPS=1                       # Caddy 反代；不设则限流/WS 上限共用一个桶
WRITE_ACCESS_MODE=gated
WRITE_PASSPHRASES=<你的团队口令>
ADMIN_TOKEN=<管理员令牌>
```

### 3.3 规格

5 人团队 + 100MB 文件上传：轻量应用服务器 2 核 4G / 5-10Mbps 带宽即可。注意上行带宽。

### 3.4 安全组

只放行 **80 / 443**，不开 8000。应用不直接暴露，Caddy 是唯一入口（现有 `docker-compose.yml` 已是这个结构）。

### 3.5 部署

```bash
cp .env.example .env && chmod 600 .env && $EDITOR .env
$EDITOR Caddyfile   # 换成你的域名
docker compose up -d --build
./scripts/backup.sh  # 挂 cron 每日一次，归档拷到对象存储 COS
```

## 4. S9 待完成加固项（公网团队部署前必做）

| 项 | 说明 | 状态 |
|----|------|------|
| 公开 Pad 文件删除权限收紧 | 反转 v1.1.2：非 admin 只能删自己上传的文件（`src/services/fileService.ts` deleteFile/clearFiles） | 待办 |
| 备份恢复演练 | 已有 `scripts/backup.sh`，需挂 cron + 异地拷贝 + 验证一次恢复 | 待办 |
| 公开 Pad #1 收纳 | 旧库若仍有公开 Pad #1，迁移或删除 | 待办 |

## 5. 后续（阶段 1-2，见竞品分析报告）

- 在线成员 + 远端光标（presence，此时有昵称才有意义）
- Pad 历史版本 + 回收站
- 冲突提示 UI（gated 模式下 WAN nack 更频繁）
- CRDT（Yjs）演进预研
