# 竞品代码级深挖（2026-09-03）

> 前置阅读：[competitive-analysis.md](competitive-analysis.md)（基于公开资料的项目选型对比）。
> 本篇是进阶版：**直接克隆源码逐行分析**，对象为 HedgeDoc、Etherpad、Yjs/y-websocket、ShareDB、Docmost、Memos、SilverBullet（浅克隆快照，commit 为 2026-09-03 main 分支）。
> 结论只做分析与建议，不改动源码。

---

## 1. 执行摘要

7 个项目的源码读完后的核心判断：**我们的架构选型（单进程 + SQLite + DMP patch）不用推翻，但同步协议、持久化策略、文件生命周期三个方向上，竞品都给出了更成熟的、可直接移植的实现。**

最值得搬的五件事（按优先级）：

| # | 优先级 | 优化点 | 参考实现 |
|---|--------|--------|----------|
| 1 | P0 | patch-ack 不回全量正文，改回 rev 号（Etherpad ACCEPT_COMMIT 模式）；每条 patch 携带"基于服务端版本号"，不符即 nack | `etherpad-lite/src/node/handler/PadMessageHandler.ts:963-1027` |
| 2 | P0 | FTS5 从"每击键全量重建"改为节流快照式刷新（或按 pad 粒度单行 REPLACE） | HedgeDoc `backend/src/realtime/realtime-note/realtime-note.service.ts:90-119` |
| 3 | P0 | 文件 72h TTL 硬删改为"未被正文引用 + N 天未访问"GC；文件操作全量 async 化（tmp + rename 原子写） | Docmost `attachment.service.ts`、SilverBullet `server-common/src/space/disk.rs:355-405` |
| 4 | P1 | 轻量 presence 消息：单调 seq + 15s 心跳重播 + 30s 超时清理 + 新连接推快照 | Yjs awareness 协议、HedgeDoc `realtime-user-status-adapter.ts:44-148` |
| 5 | P1 | 登录/unlock 接口加时间桶锁定（~80 行）；敏感路由独立限流桶 | SilverBullet `server/src/auth/lockout.rs:6-73`、Docmost 分类限流 |

---

## 2. HedgeDoc（3.x，NestJS + Yjs）

1. **服务器只转发 update，不做 OT 合并**。`RealtimeNote` 持有共享 `RealtimeDoc`（`backend/src/realtime/realtime-note/realtime-note.ts:28,48`），每连接经 `YDocSyncServerAdapter` 绑定同一 doc（`realtime-connection.ts:47-51`）。击键只传增量二进制 update——不存在"ack 回全量正文"。
2. **持久化降频**：`startPersistTimer` 按分钟级间隔定时快照 + 销毁前强制保存（`realtime-note.service.ts:90-119`），revision 在快照时才生成。→ 我们的 FTS 全量重建可改成同款节流。
3. **Revision 存"全量 content + 相邻 patch + state vector"**（`revisions.service.ts:377-391`），历史回放走 patch 链，只有快照点存全量。
4. **Presence 一等公民**：`realtime-user-status-adapter.ts:44-56` 每 RealtimeUser 带 `cursor:{from,to}`；客户端发单条状态更新，服务器并入 `REALTIME_USER_STATE_SET` 完整状态包广播（`:129-148`）——服务器不解析位置，纯状态搬运，成本极低。
5. **空房间 10s 延迟销毁**（`realtime-note.ts:21,91-98`）：断线几秒内重连直接复用内存 doc，不需要客户端 localStorage 对账。
6. **权限变化实时作用到连接**：降级时更新 `acceptEdits` 闸门或直接断开（`realtime-note.service.ts:162-177`）——写权限检查应在 patch 入口，而非只在握手。

## 3. Etherpad

1. **客户端 changeset 带 `baseRev`，服务器 `follow()` rebase 到最新 revision**（`PadMessageHandler.ts:963-981`）；广播的是 changeset 本身（小 diff），提交者只收 `ACCEPT_COMMIT {newRev}`（`:1024-1027`）——ack 只有几字节。
2. **每 pad 串行化写队列（Channels）**（`PadMessageHandler.ts:180-215`）：同 pad 消息按序处理，跨 pad 并行。防乱序的核心。
3. **重传幂等**：changeset 与已存 revision 相同且同作者 → 视为重传转 identity（`:972-975`）。断线重发天然安全。
4. **历史恢复 = rev 追赶**：重连后 `CHANGESET_REQ {start,end}` 逐 revision 下发（`:595,1043-1078`），比 localStorage shadow 对账简单可靠。
5. **Key revision**：每 100 revision 存一次全量 atext+pool（`Pad.ts:353-356,544-546`）——FTS 重建甚至可以只在这个粒度做。
6. **限流更细**：每 IP 每秒 10 条、按消息计、超限显式 `rateLimited` 断开（`PadMessageHandler.ts:79,395-400`；`Settings.ts:855-861`）。我们 120/min 粒度太粗、挡不住突发。
7. **Presence 按作者去重**：同 authorID 多窗口只在最后一个 socket 离开才广播 leave（`:269-294`）。

## 4. Yjs / y-websocket

（注：本地克隆的 y-websocket v4 只含客户端 provider，服务端在独立仓库 `@y/websocket-server`；awareness 线协议在 `@y/protocols`。）

1. **4 种消息**：sync(0) / awareness(1) / auth(2) / queryAwareness(3)（`y-websocket.js:20-23`），二进制帧；一帧可打包多消息、处理结果可合并回写（`:125-138,241-248`）省 RTT。
2. **Awareness 是独立易失通道**：不进文档、不持久化；单调 `clock` 防回放、15s 全量重播、30s 无刷新判掉线自动清除——用超时而非显式 leave 收敛在线状态。
3. **离线恢复不需要操作队列**：本地 doc 持续 apply 编辑，重连后发 sync step 1（state vector），服务端回精确 diff（`:264-268`）；乱序更新存 `pendingStructs` 等缺口补齐（`yjs/src/utils/StructStore.js:14-20`）。
4. **同步状态指示**：unconfirmedUpdates 按 ContentId 扣减，给出 yellow→green 精确同步反馈（`:52-64,466-487`）。
5. **重连退避状态机**：指数退避 `2^n*100ms` 上限 2500ms、成功 sync 清零、关闭码 4400-4499 永久拒绝 / 4500-4599 可重试（`:140-153,198-221,572-575`）。我们应定义私有关闭码段。
6. **DMP 架构上的并发风险清单**（对照我们单 in-flight + ack 模型）：
   - ack 与远端 text-update 乱序 → shadow 与服务端序列错位，后续 patch offset 打错位置。**每条 patch 带 baseRev，不符即 nack 重同步**是廉价补丁。
   - nack 后重放原 patch 会二次错位——必须基于新 shadow 重新 `patch_make`，不能重发。
   - 跨客户端并发：单 in-flight 只保证每客户端串行，服务端必须按 pad 串行 apply + 版本校验。
   - 离线队列重连时应 **squash 成单一聚合 patch**（基于上次确认 shadow 重新生成），而非逐条重放。
7. **结论：引入 Yjs 不值**（局域网 RTT<1ms、并发窗口小，CRDT 优势用不上，代价是全栈更换+SQLite 存二进制 update 需 compaction）；抄协议设计即可。

## 5. Docmost（NestJS + Postgres）

1. **附件先鉴权后写盘、永远挂在实体下**：上传前 `validateCanEdit`（`attachment.controller.ts:124`），无无主文件；删除"先删对象存储再删 DB 行"，逐个 try/catch（`attachment.service.ts:300-375`）。
2. **文件名净化先 `decodeURIComponent` 再 sanitize**，点名防 `..%2F` 绕过（`common/helpers/utils.ts:106-124`），截 255 字符；SVG 不设 Content-Length 防 XSS（`:577-579`）。
3. **分类限流桶**：AUTH 10/min、OAUTH_REGISTER 10/hour 等，按路由开关（`integrations/throttle/throttle.module.ts:25-42`）——注册/邀请类路由不该和正常 API 共享池。
4. **审计日志模块**：上传等敏感操作写 `auditService.log({event, resourceType, metadata})`，专用表迁移（`attachment.controller.ts:139-153`）。
5. **搜索 = DB 触发器增量维护**：tsvector 触发器只重算该行（`database/migrations/20240324T086800-pages-tsvector-trigger.ts:4-14`），对照我们每击键全量重建 trigram，写放大高几个数量级。

## 6. Memos（Go + SQLite）

1. **附件无 TTL 硬删**，生命周期跟内容走；删除走"策略 + 乐观并发"，事务内比对内容快照（`store/attachment_delete.go:17-27`），且有配套单测。
2. **上传安全**：`http.DetectContentType` 内容嗅探 + 扩展名回退（`api/v1/attachment_service.go:47-71`）；`filepath.IsLocal` 拒绝非本地路径（`attachment_service_storage.go:289`）；缩略图信号量限并发、probe 限流读。
3. **SQLite 配置一次 Open 全配好**：DSN 内联 `busy_timeout/journal_mode(WAL)/mmap_size`（`store/db/sqlite/sqlite.go:36-47`）。

## 7. SilverBullet（Rust 版）

1. **原子写范式**：写 dot 前缀临时文件 → `fs::rename` 原子替换，"no reader ever observes a partial file"（`server-common/src/space/disk.rs:355-405`）——Node 下 `fs.rename` 同样原子，可直接移植。
2. **登录锁定 LockoutTimer**：时间桶计数（默认 10 次/60s，env 可调），实现仅 ~80 行带单测（`server/src/auth/lockout.rs:6-73`）。
3. **缓存有界化**：hash 缓存 FIFO 限容 10k、路径锁 sweep 防泄漏（`server/src/fs_guard.rs:11-33`）。
4. **watcher debounce**：洪水事件折叠成一次 resync（`server/src/watcher.rs`）。

---

## 8. 对照我们的落地方案

综合三份分析，按"改动小收益大"排序：

1. **P0 同步协议改造**：服务端每 pad 内存权威副本 + 递增 rev；patch 消息带 baseRev；ack 只回 `{rev, textVersion}` 不回正文；不符即 nack 全量重同步。照 Etherpad ACCEPT_COMMIT。注意我们的离线队列重连改为 squash 聚合 patch。
2. **P0 FTS 写入降频**：patch 落库改 debounce（200-500ms/pad 合并写），FTS 重建只随节流快照做；确认 `padService` 对同 pad patch 严格串行。
3. **P0 文件生命周期**：废 72h 硬删 → "正文未引用 + N 天未访问"GC 或回收站；`unlinkSync` 全换 `fs.promises`；写文件改 tmp+rename 原子替换。
4. **P1 presence 协议**：`{type:'presence', seq, name, color, cursor}` 单向广播；15s 心跳/30s 超时清理；新连接服务端推快照；远端 patch 到达时本地光标做 offset 重映射。
5. **P1 限流细化**：WS 消息级限流（1s/10 条 + `rateLimited` 断开）；登录与 unlock 加 LockoutTimer；注册/邀请独立限流桶；补轻量 audit 表（event/user/ip/ts）。
6. **P1 重连体验**：空 pad 会话保留 ~10s 内存副本，重连走 rev 追赶，localStorage 队列降级为兜底；重连退避抄 y-websocket 状态机，定义 4400-4499 永久 / 4500+ 可重试关闭码段。
7. **P2 上传加固**：MIME 内容嗅探（`file-type`）、文件名先 decode 再 sanitize、SVG 特判；上传缩略/probe 并发限幅。

### 明确不建议做的

- **引入 Yjs/CRDT**：场景不匹配（局域网、低并发），迁移成本远超收益；只抄 awareness 协议与重连状态机。
- **Postgres/Redis**：Memos、SilverBullet 证明了 SQLite 单文件足够支撑我们的规模，关键是把写入策略做对，而不是换存储。
