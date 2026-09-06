# 自托管部署与运维手册

面向「部署到自己的服务器」的完整流程：**Docker Compose + Caddy 自动 HTTPS**。
日常开发请继续用 `npm run dev`；本文只覆盖生产部署。

---

## 1. 前置条件

| 项目 | 要求 |
|---|---|
| 服务器 | 任意能跑 Docker 的 Linux（含 1 vCPU / 2GB 内存的小机型） |
| Docker | Docker Engine + **Compose v2**（`docker compose version` 有输出） |
| 域名 | 一个已指向本服务器 A/AAAA 记录的域名 |
| 端口 | **80 与 443 必须对外开放**，Caddy 用 80 完成 ACME 校验才能签发证书 |

---

## 2. 首次部署

```bash
git clone <your-repo> comark-notepad
cd comark-notepad

cp .env.example .env
# 必填两项：
#   SESSION_SECRET  —— openssl rand -hex 32
#   PUBLIC_ORIGIN   —— https://notepad.example.com
chmod 600 .env          # .env 含会话签名密钥，禁止其他用户读取

# 把 Caddyfile 里的 notepad.example.com 换成你的域名（Caddy 依据它申请证书）
$EDITOR Caddyfile

docker compose up -d --build
docker compose logs -f
```

`PUBLIC_ORIGIN` 必须以 `https://` 开头。生产环境的会话 Cookie 带 `Secure` 标志，
若这里写成 `http://`，浏览器会丢弃 Cookie，表现为**登录无反应**。该情况启动时会有告警。

---

## 3. 验证部署

```bash
# 容器健康状态（Docker 每 30s 探测一次）
docker inspect --format '{{.State.Health.Status}}' comark-notepad

# 就绪探针：确认数据库可访问
docker compose exec comark-notepad wget -qO- http://localhost:8000/api/health/ready

# 从公网验证（应返回 200）
curl -i https://notepad.example.com/api/health
```

两个探针的区别：

- `/api/health` ——**存活探针**，只看进程是否活着，**不碰数据库**。Docker 连续失败会重启容器，
  因此它故意不查询 SQLite，避免进程因一次繁忙的 checkpoint 而被误杀。
- `/api/health/ready` ——**就绪探针**，会查数据库并返回 `pads` / `files` 数量；数据库不可用时返回 503。
  `scripts/deploy.sh` 用它判断新版本是否可用。

> 注意：`/api/health` 早期版本曾返回 `pads`/`files` 字段，现已移到 `/api/health/ready`。
> 若你有外部监控读取这两个字段，请改指到就绪端点。

---

## 4. 更新与回滚

```bash
./scripts/deploy.sh --pull      # 拉代码 → 备份 → 构建 → 重启 → 等健康检查
./scripts/deploy.sh             # 不拉代码，用当前工作树构建
```

脚本行为：

1. 部署前**自动备份**（若容器在跑）。
2. 给当前镜像打 `comark-notepad:rollback` 标签。
3. 构建并启动新容器。
4. 等容器变 `healthy`；**超时则自动回滚**到上一个镜像并重启。

需要人工回滚时：

```bash
docker tag comark-notepad:rollback comark-notepad:local
docker compose up -d --no-deps comark-notepad
```

---

## 5. 备份与恢复

### 备份

```bash
./scripts/backup.sh
# BACKUP_DIR=/mnt/nas/notepad RETENTION_DAYS=30 ./scripts/backup.sh
```

产出 `backups/<时间戳>.db`（数据库）与 `backups/<时间戳>-files.tgz`（上传文件）。
默认保留 14 天。

推荐加一条 cron（每天 03:00）：

```cron
0 3 * * * cd /srv/comark-notepad && ./scripts/backup.sh >> /var/log/notepad-backup.log 2>&1
```

脚本通过 SQLite 的 backup API 取快照，**而不是 `cp store.db`**——服务运行时数据库旁有
`store.db-wal`，直接拷贝主文件可能拿到半个 checkpoint 的损坏数据。

### 恢复

首选脚本（自动停机 → 恢复库与文件 → 清理 WAL → 重启）：

```bash
./scripts/restore.sh <时间戳>
# BACKUP_DIR=/mnt/nas/notepad ./scripts/restore.sh 20260906-030000
```

手工等价操作：

```bash
docker compose stop comark-notepad

# 卷名带 compose 项目前缀，先确认实际名字
docker volume ls | grep notepad-data
VOLUME=<上一步查到的名字，如 comark-notepad_notepad-data>

docker run --rm -v "$VOLUME":/data -v "$PWD/backups":/backup alpine \
  sh -c 'cp /backup/<时间戳>.db /data/store.db && rm -f /data/store.db-wal /data/store.db-shm'

# 需要时一并恢复上传文件
docker run --rm -v "$VOLUME":/data -v "$PWD/backups":/backup alpine \
  sh -c 'rm -rf /data/files && tar xzf /backup/<时间戳>-files.tgz -C /data'

docker compose start comark-notepad
```

> 替换 `store.db` 后**必须删除 `-wal` / `-shm` 文件**，否则 SQLite 会用旧的 WAL 覆盖新数据。

### 恢复演练记录（2026-09-06，v1.2.4）

备份 → 清空 → 恢复 → 验证的完整闭环已实际执行一次（宿主机直跑同一机制：
`scripts/sqlite-backup.js` 活体快照 + files 归档），验证项全部通过：

1. **事务一致性** — 服务器运行中取快照；快照之后的写入（`POST-SNAPSHOT-WRITE`）没有出现在
   恢复结果中，恢复到的正文停在快照时刻（v1）——backup API 快照是事务一致点。
2. **文件完整** — 上传附件恢复后字节数与库内 `files.size` 记录精确一致。
3. **FTS 可用** — 启动时 `reconcileSearchIndex()` 从恢复库自动重建索引，搜索立即可用。
4. **健康探针** — 恢复实例 `/api/health/ready` 返回 200（pads/files 计数正确）。

> 演练教训（已写进脚本）：快照先落在数据卷的 `data/backups/` 里，必须**拷出到宿主机备份目录**
> 之后才敢对卷做任何破坏性操作——`backup.sh` 已含这一步，`restore.sh` 则要求备份目录独立于数据卷。

公网上线前请照此在**自己的部署环境**重跑一次：备份一份 → 停机 → `./scripts/restore.sh` → 核对
正文/文件/搜索 → 确认无误。cron 定时与异地拷贝（备份目录同步到另一台机器/对象存储）属运营侧配置，
脚本不覆盖。

---

## 6. 日志与监控

```bash
docker compose logs -f comark-notepad      # 实时日志
docker compose logs --tail=200 caddy       # 反代日志
docker compose logs --since 1h comark-notepad
```

- 生产环境输出 **JSON 结构化日志**（pino），便于接入 Loki / Vector / ELK。
- 日志级别由 `.env` 的 `LOG_LEVEL` 控制（默认 `info`；排障时临时设 `debug`）。
- **访问日志**记录 `method / path / status / 耗时 / IP`；`4xx` 记 warn、`5xx` 记 error。
  健康检查请求不记录，避免 30 秒一次的探测刷屏。
- 敏感头（`cookie`、`authorization`、`x-pad-token`）在日志中自动脱敏为 `[REDACTED]`。
  Pad 解锁 token 走 `X-Pad-Token` 头，一旦被打印就等于泄露长期凭证。
- 日志已配置滚动（单文件 10MB、最多 3 份），防止占满磁盘。

关注的关键信号：

```bash
# 5xx 错误
docker compose logs comark-notepad | grep '"status":5'
# 启动配置告警
docker compose logs comark-notepad | grep -i 'warn'
```

---

## 7. 资源占用调优

默认配置的内存预算（`docker-compose.yml`）：

| 用途 | 上限 |
|---|---|
| 容器总内存 `mem_limit` | 1536 MB |
| 主进程堆 `NODE_OPTIONS` | 384 MB |
| 转换 worker | 2 并发 × 256 MB = 512 MB |
| 运行态、SQLite、待转换文件缓冲 | 余量 |

**转换内存是峰值大户**，且转换中的文件会被短暂持有两份（主进程一份，
结构化克隆给 worker 线程一份）。因此：

```
峰值 ≈ NODE_OPTIONS + CONVERT_MAX_CONCURRENT × CONVERT_WORKER_HEAP_MB + 文件大小 × 2
```

调节规则：**提高并发前，先按同样的倍数提高 `mem_limit`**。
代码默认是 3 并发 × 512MB（1.5GB 峰值），对小机器过于激进，故 compose 里调低了。

小内存机器（总内存 1GB）建议：

```yaml
mem_limit: 768m
environment:
  NODE_OPTIONS: "--max-old-space-size=256"
  CONVERT_MAX_CONCURRENT: "1"
  CONVERT_WORKER_HEAP_MB: "192"
```

观察实际占用：

```bash
docker stats comark-notepad
docker compose logs comark-notepad | grep -i 'heap\|oom'
```

> 若容器被 OOM killer 杀掉（ExitCode 137），优先下调上面三项，而不是一味加内存。

---

## 8. 安全加固清单

`docker-compose.yml` 已启用：

- `read_only: true` —— 根文件系统只读，仅 `/app/data`（卷）与 `/tmp`（tmpfs）可写
- `cap_drop: [ALL]` —— 丢弃全部 Linux capabilities
- `no-new-privileges:true` —— 禁止提权
- `init: true` —— 正确回收僵尸进程、转发 SIGTERM
- 应用**不发布宿主机端口**，Caddy 是唯一入口

建议另外做到：

- [ ] `.env` 权限 600，且不进版本库
- [ ] 服务器防火墙只放行 22 / 80 / 443（不要用 compose 把 8000 暴露到公网）
- [ ] 设置 `ADMIN_TOKEN` 以便应急管理
- [ ] `TRUST_PROXY_HOPS=1`（已在 compose 设置）；若置 0，限流与每 IP 的 WebSocket 上限
      会把所有用户算成同一个 IP
- [ ] 定期 `docker compose pull caddy` 或直接固定 Caddy 镜像摘要

---

## 9. 故障排查

| 现象 | 原因与处理 |
|---|---|
| 登录后无反应 / 反复回登录态 | `PUBLIC_ORIGIN` 是 `http://` 但站点是 https，或反之。Cookie 带 `Secure`，必须 https；启动日志会有告警 |
| 所有人共用一个限流额度 | `TRUST_PROXY_HOPS` 为 0。设为 1（反代一跳） |
| 容器反复重启 | 看 `docker compose logs`。存活探针不查库，所以重启通常是进程崩溃（如 OOM，ExitCode 137） |
| 上传大文件被拒 | Caddyfile 的 `request_body.max_size` 需 ≥ `CONVERT_MAX_BYTES`（默认 100MB） |
| 转换时报「Too many conversions」 | 并发达 `CONVERT_MAX_CONCURRENT` 上限，属正常限流，稍后重试或调大并发 |
| 容器起不来且报只读文件系统错误 | `read_only: true` 与新写入路径冲突。可临时注释该行定位，并补一条 tmpfs |
| 证书签发失败 | 80 端口未放行，或 DNS 未指向本服务器。查看 `docker compose logs caddy` |

---

## 10. 附：非 Docker（systemd）部署

若不用容器：

```bash
npm ci && npm run build
```

`/etc/systemd/system/comark-notepad.service`：

```ini
[Unit]
Description=Collab Notepad
After=network.target

[Service]
Type=simple
User=notepad
WorkingDirectory=/srv/comark-notepad
EnvironmentFile=/srv/comark-notepad/.env
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now comark-notepad
```

此时仍需 Caddy/Nginx 做 TLS 与反代，并设 `TRUST_PROXY_HOPS=1`。
