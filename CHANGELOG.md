# Changelog

All notable changes to this project are documented in this file. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### 健壮性与每请求开销修复（代码级审查落地）

1. **优雅关停顺序修复（正确性）** — 原先 `store.flushSync()`（其内部是 `sqlite.close()`，会把 DB 句柄置 null）在排空请求**之前**执行：SIGTERM 后最长 5 秒的排空窗口内，任何在途请求再碰数据库都会得到 `null.prepare` TypeError → 500。现在 SQLite 只在 `server.close()` 排空回调内关闭，FTS flush 仍在关库前（库还开着时）执行；排空时补 `closeIdleConnections()`，keep-alive 空闲连接不再把 `server.close()` 拖到 5 秒硬超时。
2. **进程级异常兜底** — 新增 `unhandledRejection`（记录、不退出：TTL 清理这类异步旁路任务的失败不应拖垮整个实例）与 `uncaughtException`（走同一套排空流程、以非零码退出）处理器。文件 TTL 定时任务补上 `.catch`——此前一次 `SQLITE_BUSY`/IO 错误就会以 unhandled rejection 杀死进程（Node ≥15 默认行为）。
3. **转换 worker 内存峰值 ≈5× → 1×** — `convert-worker.js` 里九处 `Buffer.from(buffer)`（PDF/XLSX/DOCX/PPTX/图片路径、zip 预检、文本解码）都在结构化克隆副本之外又堆上第二份全量拷贝，100MB 输入峰值内存约 500MB，直接顶穿 worker 堆上限导致大文件转换必然 OOM。全部改为按引用使用（`buffer` 本身是只读的克隆副本；PDF 路径用 `Uint8Array` 视图替代拷贝），峰值回落到克隆本身。
4. **gated 模式每击键 2 次 `write_grants` 查询 → 1 次** — `requireWriteAccess`（HTTP）与 WS patch 复检原先各自执行 `status()` + `renewIfNeeded()`，两次 SELECT 查同一行。滑动续期改为 `renewFromStatus(userId, status)`，直接复用刚算出的 status，不再回库。
5. **锁定 Pad 的请求不再为读一个布尔值拖出全文** — `requirePadUnlock` 原先走 `findById`（`SELECT *`，含最多 100KB 正文）只为检查 `pad.password`。新增 `padService.getPadMetaById`（`findByIdMeta`），并且 **meta 查询补上 `text_version` 列**——此前 `rowToPadMeta` 返回恒为 0 的 `textVersion`（类型上是完整 `Pad`，实则靠约定防雷），现在 meta 行可以如实回答"这个 Pad 在第几版"，条件更新检查不再依赖全文行。
6. **静态资源不再过会话鉴权** — `express.static` 移到 body parser 与 `authenticate` 之前：此前页面加载的每个 JS/CSS/图片请求都要付 cookie 解析 + HMAC 校验 + `users` 表查询。同时删除挂在 `/vendor` 的冗余静态挂载（`public/` 已包含 `public/vendor`）。
7. **SQLite `synchronous=NORMAL`（WAL 标准搭配）** — 此前每击键提交都 FULL fsync；NORMAL 下掉电最多丢最近提交、不会损坏库。
8. **杂项** — 文件 TTL 清理的兜底 Pad 查找改用 `findAllMeta()`（原先 `findAll()` 会把全部 Pad 正文拉进内存），无 Pad 可广播时静默跳过；启动日志的 Pad 计数改用 `count()`。
9. **回归测试** — `tests/concurrency.test.js` 新增「同一 `operationId` 重试必须按重复处理而非 nack」用例（ACK 丢失重发场景：去重表必须在版本检查前短路，重复投递不得再次推进版本）。

## [1.2.3] - 2026-09-05

### 同步协议瘦身 + FTS 节流 + 文件生命周期修复（竞品代码级分析落地）

> 依据：`docs/competitive-analysis-code-level.md`（HedgeDoc / Etherpad / Yjs / ShareDB / Docmost / Memos / SilverBullet 源码对比）。Etherpad `PadMessageHandler.ts` 的 `ACCEPT_COMMIT`（ack 只回版本号）与 HedgeDoc `realtime-note.service.ts` 的「定时快照代替每键写库」是本次改造的两个主要参照。

1. **patch-ack 与 patch 广播帧去全量正文（P0，带宽/序列化 CPU）** — 服务端 `applyPatch` 本就要求客户端携带 `baseVersion` 且与 `pad.textVersion` 一致才应用，因此 ack 时刻服务端正文**必然**等于发送方已持有的 `sentText`，回传全文是零信息的双份序列化。现在 `patch-ack` 只回 `{textVersion, seq}`；广播帧同样只含 diff，接收方对本地 shadow `patch_apply` 重建正文（此前每击键向每个其他客户端多推一份最多 100KB 的正文），失败时沿用 HTTP `loadPadContent()` 重同步。`ackInflight` 相应简化（shadow 直接推进到 `sentText`，DOM 写路径删除）。
2. **IME 组合态兼容 diff-only 广播** — `applyRemotePatch` 原先只在「携带权威正文」分支有 IME 暂存；正文取消后补丁帧改为 park 成 `pendingRemotePatch`（core.js per-pad 状态新增字段），`compositionend` 时先于 `pendingRemoteState` 回放，继续保证组合态不写 `textarea.value`。
3. **FTS 索引从「每击键全量重建」改为按 Pad 节流刷新（P0，写放大）** — 删除 `pad_au` UPDATE 触发器（`DROP TRIGGER IF EXISTS`，老库幂等迁移），`db/pads.ts` 新增 per-pad 防抖（`FTS_SYNC_DEBOUNCE_MS`，默认 1200ms）：窗口内多次编辑只保留最新正文，窗口结束时一个事务批量 `UPDATE pad_search`。**正文行仍同步落盘**（崩溃丢数据窗口不变，测试以 SIGKILL 清场故不做落库 debounce），仅 trigram 重分词延迟；启动时 `reconcileSearchIndex()` 从 `pads` 表全量对账，停机时 `flushSearchSyncNow()` 收尾。搜索一致性窗口 ≤ 1.2s，已记入文档。
4. **文件 TTL 回收加引用保护（P0，数据安全）** — `findExpired` 增加反连接子查询：正文含 `files/<id>` 引用的附件**永不过期**（删除被正文引用的文件会留下永久破图/死链）。TTL 语义变为「未被任何 Pad 正文引用且超过 `FILE_TTL_HOURS`」。`deletePad` / `deleteFile` / `clearFiles` / 转换替换源文件 / TTL 批清理全部改为 `fs.promises.unlink`（并发），`cleanupExpiredFiles` 转 async。
5. **上传原子化** — 上传先写 `.part` 临时文件，流结束后 `rename` 到最终名；并发读侧要么看到完整文件要么看不到，不再可能读到半截正文。失败/中止路径清理临时文件（fire-and-forget async unlink）。
6. **在线成员 presence（P1，协作可感知性）** — 新增 `{type:'presence'}` / `{type:'presence-request'}` WS 消息：客户端在输入/空闲翻转时广播 `{name, active}`（500ms 节流），服务端**只转发不存储**（400ms/连接节流防刷），新连接加入时全房间（含新连接）应答一轮实现秒级收敛；断开时服务端广播 `gone`，客户端另有 35s 陈旧度兜底清理。UI 为头部彩色芯片（颜色由 wsId 哈希得出），active 成员呼吸闪烁；移动端隐藏。刻意**不做 textarea 远端光标叠加**（原生 textarea 无法承载 caret overlay，属独立专题）。
7. **测试** — 新增 5 例：陈旧 baseVersion 拒收并回传权威正文、匹配 baseVersion 接受且 ack 无正文、presence 转发/回显排除/离场广播、FTS 节流前后搜索可见性、TTL 回收保留被引用文件且异步删除磁盘文件；原「广播帧必须携带正文」断言反转为「必须 diff-only」。当时全量 91/91；最终全量见下方「并发协议收紧」（102/102）。
8. **环境变量** — 新增 `FTS_SYNC_DEBOUNCE_MS`（默认 1200）；`FILE_TTL_HOURS` 语义更新（仅回收未被引用文件），`.env.example` / README 同步。

### 并发协议收紧：并发控制由 opt-in 改为强制（P0，2026-09-04）

1. **`baseVersion` 改为强制（P0，正确性）** — `padService.applyPatch` 与 `updateText` 原先在 `baseVersion` 缺失时**整段跳过版本校验**，使乐观并发控制形同 opt-in：任何客户端只要省略这个字段，就能把基于旧版本的 patch / 整篇正文直接套用到服务端当前状态上，静默覆盖并发编辑。现在缺失即拒绝（WS 返回 `patch-nack`，HTTP 返回 `409 conflict` 走客户端既有的重同步合并路径）。自带客户端本就每次都发送 `baseVersion`，因此正常协作路径不受影响。

   > **行为变更**：直接调用 API 的外部脚本/旧客户端必须为写请求带上 `baseVersion`，否则会被 `409` 拒绝。这是收紧协议换取正确性的必要代价。

2. **WS 握手改为 fail-closed（P1，安全）** — `isAllowedOrigin()` 对**缺失** `Origin` 头返回 `true`（fail-open），而 WS 鉴权路径直接复用该函数且没有 Referer 兜底，导致任何不带 `Origin` 的 WS 客户端都能进入 pad 房间。浏览器在 WS 握手时总是发送 `Origin`，因此默认改为拒绝；非浏览器/脚本客户端需显式 `WS_ALLOW_NO_ORIGIN=true` 才放行。

3. **回归测试** — 新增 `tests/concurrency.test.js`（4 例）：省略 `baseVersion` 的 patch 必须被 nack 且不覆盖并发编辑、省略 `baseVersion` 的整篇写入必须 409、无 `Origin` 的 WS 必须被 4400 拒绝、opt-in 时脚本客户端仍可连接。原「并发 patch 两个都成功」的用例改写为「同 base 的两个 patch 只有一个生效、另一个 nack」——它此前正是依赖被跳过的版本校验才成立。全量 **102/102** 通过。

### 安全专项修复（S1–S8，2026-09-03）

> 覆盖：依赖漏洞 / 后端权限 / 前端 XSS / 文件上传与转换 / WebSocket / 数据库与配置脱敏。完整审计后修复 8 项，新增回归测试 `tests/security.test.js`。`npm audit` 复核：**0 漏洞**（含把 `dompurify` 固定到已修复 mXSS 的版本）。

1. **WS 原型链污染崩溃（P0，S1）** — `src/ws/index.ts` 在 `safeParse` 之外、直接 `Object.assign` 客户端帧前，恶意 `{type:"constructor", ...}` 会触碰 `Object.prototype`，引发同步 `TypeError` 杀进程。改为对所有 `message.data` 先做 `try/catch JSON.parse` + 结构守卫，`type` 必须是枚举白名单字符串才进入分发；非法帧仅记录并丢弃，不再抛出。
2. **WS 过长 close reason RangeError 崩溃（P0，S2）** — 早期 `try/finally` 中对 `ws.close(...)` 传入超长 `reason` 会抛同步 `RangeError`（非法长度），该异常逃出 `handleClose` 顶层。改为 `safeClose()` 封装（`src/ws/close.ts`）：对 `reason` 截断到 123 字节并 `try/catch`，连接准入 / auth 握手 / 消息分发 / 写门控 / 优雅关闭等**全部**关闭路径统一走它；帧拒绝路径（`rejectFrame`）保留「细节进日志、客户端只收固定短 reason」的语义并复用 `safeClose`。
3. **上传 rename 后孤儿文件 + 字段顺序绕过（P1，S3）** — `fileService.uploadFile` 先前先 `rename` 落盘再校验权限/配额，被拒的上传会留下无法回收的磁盘孤儿文件；且校验依赖请求字段顺序，畸形体可绕过早期检查。`convert-worker.js` 与 `fileService` 改为**先鉴权、先配额、先写 `.part` 临时文件，`rename` 成功后才计入库**；所有失败/中止路径清理 `.part`（fire-and-forget `fs.promises.unlink`）。
4. **padService 空守卫（P1）** — `padService.getPad` / `getState` / `applyPatch` 在 `pad` 为 `null` 时补 `ForbiddenError`/`BadRequest` 守卫，避免空值向下透传导致 500 或误读。
5. **XLSX 解压炸弹 OOM（P1，S4）** — 转换路径按中央目录声明的 `uncompressedSize` 直接 `Buffer.alloc` 解压，恶意 zip 可瞬间分配数 GB 致 OOM。`convert-worker.js` 改为**两层防御**（上限复用 `CONVERT_MAX_BYTES`，经 `workerData.maxBytes` 注入）：① 中央目录**声明预检**——per-entry / 总量上限 + 压缩比率检查（`getEntries()` 只解析中央目录，不解压，检查本身不可攻击）；② **实际流式解压验证**——每个 entry 经 zlib 流式管道解压，累计输出超过上限立即中止，chunks 只计数不物化。声明尺寸撒谎时，真实输出一旦越过上限即被捕获，解析库随后的解压不可能超过已测得的真实尺寸。代价：OOXML 解压两遍（验证 + 解析），在 60s 超时的 worker 内可接受。
6. **嵌套 worker 僵尸（P1，S5）** — 转换超时后 `worker.terminate()` 未 `await`，且孙 worker（`worker-f`，read-excel-file 内部解析线程）未设 `resourceLimits`，超时后成为无父引用僵尸。`convertService` 改为 `await terminate()` 并给**外层** worker 设 `resourceLimits`。孙 worker 本进程无句柄、`resourceLimits` **无法**注入——其内存改由 `assertSafeArchive` 的流式解压验证兜底（真实解压总量限制在 `CONVERT_MAX_BYTES` 内，见 S4），外加转换并发上限。
7. **预览 XSS + DOMPurify 版本（P1，S6）** — `DOMPurify@3.0.11` 存在嵌套属性 mXSS CVE；且 `public/js/preview.js` 因模块导入路径写错**从未被加载**，预览实际退回未净化的 `innerHTML`。修正导入、固定 `dompurify` 到已修复版本、并在 `innerHTML` 前强制 `DOMPurify.sanitize`，无净化器时回落为 `escapeHtml` 纯文本。
8. **加锁 Pad 离线队列明文落盘（P1，S7）** — 离线队列以明文 `localStorage` 写入加锁 Pad 正文；队列首条是「已确认 shadow → 最新正文」的 diff，对刚加载的 Pad 而言**等同于整篇文档**，等于把受口令保护的内容以明文留在磁盘（同源任意脚本可读、且跨浏览器重启留存）。改为**加锁 Pad 的队列只存内存、绝不持久化**：`core.js` 新增 `volatilePatchQueue`，`getPatchQueue`/`setPatchQueue` 对 `isPadLocked()` 的 Pad 只走内存分支，并在 Pad 变为已知加锁态时 `localStorage.removeItem` 清除此前遗留的明文。

   > **取舍**：这是「不落盘」而非「加密落盘」——加锁 Pad 的待发离线编辑在页面重载后会丢失（加密方案可实现恢复，代价是引入客户端密钥派生与口令耦合的攻击面）。**未加锁 Pad 的队列行为不变**，仍写 `localStorage` 且配额超限时降级保留最新一条。

**权限层（S8）** — 公开 Pad 上任意自注册用户此前可删除/清空他人文件（`DELETE /api/files/:id`、`clearFiles` 仅 `checkOrigin` 未校验归属）。`routes/files.ts` 改为 `requireWriteAccess` + `requirePadUnlock` 双门控，且删除/清空经 `fileService` 内 `canAccessPad(req.userId, pad)` 复检；`security.test.js` 新增「跨用户删除被 403 拒绝」用例。

**回归测试** — 新增 `tests/security.test.js`（**7 例**全绿：恶意 WS 帧不崩溃、被拒上传不留孤儿文件、跨用户删文件被拒、压缩炸弹被拒且进程存活、聚合/按账户存储配额各 1、注册限流；后三项属 9.3/9.4 回归，随安全专项一并落地）；`tests/identity.test.js` / `tests/smoke.test.js` 同步加固权限与 WS 健壮性断言。

### 范围外新增（本轮一并落地，原规格未要求）

1. **聚合存储配额** — 新增 `MAX_STORAGE_BYTES`（实例总上限，默认 2GB）与 `MAX_STORAGE_BYTES_PER_USER`（按账户上限，默认 512MB）。per-file 上限只约束单次上传，此前一个账户可反复传 100MB 直至磁盘写满。配额在 `rename` 前检查（被拒上传不留盘），`db/files.sumBytes` 支持 per-owner 聚合。
2. **presence join 节流上限** — 新连接清除房间 400ms 转发节流的操作，按 Pad 加 2s（`PRESENCE_RESET_COOLDOWN_MS`）冷却：否则一个循环重连的客户端让每个在线者在每次加入时重广播，单 socket 产生 O(N²) 帧。代价：极端场景下新加入者的收敛最迟 ~2s（仍为秒级，但低于此前「立即」）。
3. **日志脱敏补全** — pino `redact` 增加 `passphrase` / `adminToken` 键。
4. **invitations 表迁移** — 删除用户时联动清理授权（外键 CASCADE），替代手工 DELETE。
5. **store/index.ts 重构** — factory 函数改 class 形态（对齐 services 的类风格），行为不变。
6. **测试 harness 去重** — 新增 `tests/helpers.js`（`installOriginFetch` / `getPristineFetch` / `spawnServer` / `stopServer`），消除 5 个测试文件各自的复制粘贴 spawn/stop 块；smoke 保留自己的 per-request Origin 注入（其部分用例断言「无 Origin 请求被拒」）。
7. **写权限 UI 补齐** — header 新增可写态 chip（显示剩余天数 + 「放弃写权限」按钮，修复释放操作在 UI 上不可达），只读横幅同步补 `[hidden]` 显式覆盖（author `display: flex` 会压过 UA 的 `hidden` 规则，横幅此前永不可隐藏）。
8. **文档** — `docs/competitive-analysis.md`（竞品五维横评）、`docs/oss-gap-analysis.md`、`docs/public-deployment-plan.md`（公网团队部署清单）。

### 评审落地：转换破坏性写语义 + 转换配额（2026-09-04）

> 二次对抗审查发现转换路径的两个真实缺口，与 S8（跨用户删除）同源。

1. **转换属破坏性写，非读（权限缺口）** — `convertService.convert` 此前只做 `canAccessFile`（读级）检查，但转换成功后 `removeFile` + `unlink` **删除源文件**：持写权限用户可把他人上传转换掉，绕过 `deleteFile` 的 `canManagePad` 门控。现增加破坏性写门控：Pad 管理者（owner/admin）恒可；上传者本人可（转换自己的上传）；无主 legacy 上传同 `deleteFile` 放宽（登录即可）；匿名 403。回归测试：`security.test.js` 新增「跨用户转换被 403 拒绝且源文件原样存活」（当时全量 103/103，最终全量见下方 markitdown 同步条目）。
2. **转换配额旁路** — 转换产物是新 `files` 行（≤50MB 输出上限），此前**不经过**实例/按账户配额：反复转换可绕过 `MAX_STORAGE_BYTES`。现于**磁盘写入前**复检实例 + 按账户配额（复用上传语义，`resolveFileOwner` 归属），超限 413 `STORAGE_QUOTA`；被拒转换不留孤儿 md、不改源文件。

> **已知问题（本节如实记录，未修）**：① 存储配额 check-then-act 竞态——`sumFileBytes` → `await rename` → `createFile` 间让出事件循环，两个并发上传可双双通过配额检查（上传限流 20/15min/IP + 单文件 100MB + 默认 2GB，实际风险低；彻底修复需把 sum+insert 事务化）；② `findExpired` 对每个过期候选做 `pads.text` 全扫（50 Pad × 100KB ≈ 5MB/候选，每小时同步执行，数据增长后可拖慢事件循环数秒；结构修复需 `pad_file_refs` junction 表）；③ gated 模式下管理员经 WS 无法编辑——浏览器无法在 WS 握手携带 `X-Admin-Token`，管理员需兑换口令写权限（fail-closed，故无安全缺口）。

### 转换器同步：markitdown v0.1.6 → v0.1.8b1（CSV 修复落地，2026-09-04）

> 上游参照：microsoft/markitdown（本项目的转换能力源出其 markitdown-ts 集成，后被手写 worker 取代，语义以 MarkItDown 为基准）。v0.1.8b1（预发布，2026-09-04）含 37 项修复、无新特性；v0.1.7（2026-07-29）5 项。逐项对照本项目的转换器形态后，仅 CSV 语义存在可移植差距，已同步：

1. **CSV UTF-8 BOM 剥离（markitdown#2303）** — Excel 等工具导出 CSV 时前置 BOM，原实现会把 `\uFEFF` 落进表头第一格。现于解析前剥离。
2. **CSV 空白行语义对齐（markitdown#2303）** — 原实现「丢弃全部空行」；对齐为 markitdown 语义：**外层**空行（首/尾）与**表头后紧跟**的空行删除，**中间**空行保留渲染为空表格行（`|  |  |`，可能是数据的一部分）；全空输入返回空 markdown（触发既有的「Conversion returned empty result」拒绝路径）。`rowsToMarkdownTable` 加 `keepBlankRows` 选项，XLSX / PPTX 路径保持原过滤行为不变。
3. **已核对、无需同步的上游修复** — CSV 值转义管道/换行（#2266，`escapeTableCell` 原有）；DOCX 下划线/样式容错/ZIP 大小写（#2017/#2190/#2016，mammoth 1.12 ≥ CVE-2025-11849 修复版 1.11，内部处理）；XLSX showZeroes（#2064，read-excel-file 库内部，依赖已最新）；PPTX None text/chart 容错（#2059/#2194，手写提取器天然无 None 概念，空标题已有 Slide N 兜底）；URI scheme 大小写（#2121，`toLowerCase` 判断 + `/i` 兜底正则原有）；大文件字符集（#2360，本项目恒 UTF-8 `TextDecoder`）；epub/rss/youtube/ipynb/OCR 等 — 本项目不支持这些格式，非本次差距。`npm outdated` 复核：转换相关依赖（mammoth/pdf-parse/read-excel-file/turndown/adm-zip）均无更新可用。
4. **回归测试** — `convert.test.js` 新增 5 例（20/20 全绿，全量 **108/108**）：BOM 表头剥离、前导空行不毁表、尾随空行跳过、表头后空行跳过且中间空行保留为空行格、全空输入报空结果；用例逐条对应 markitdown 上游 `test_csv_*` 断言。

### 公网团队部署：写权限门控 + 字数统计 + Pad #1 弃用（2026-09-02）

1. **写权限门控（`WRITE_ACCESS_MODE=gated`）** — 公网部署下访客默认只读，持写权限才可编辑。四层模型：访客（读）/ 持令写（口令兑换，7 天滑动续期）/ 信任成员（管理员授予，永久可撤销）/ 管理员（`X-Admin-Token`）。**信任成员白名单替代了「永久后门口令」**：同样免再输口令，但按人可撤销、可审计、无共享密钥永久泄露风险。门控覆盖全部 **12 条写路径（11 条 HTTP + WS patch）**：pads 5（PUT/POST text、create、password、delete）、files 2（delete、clear）、upload、convert、invitations 2。WS 每次 patch 复检，失效发 `{type:'write-denied'}` 并以关闭码 **4405** 关闭。口令常量时间比对（复用 `timingSafeEqual`），生产环境启动自检在 `open` 模式下告警。
2. **Pad #1 弃用** — 全新部署不再播种公开 Pad #1（其 `owner_user_id=NULL` 在公网下对任何注册者可见）。`seedDefaultPad` 移除，零 Pad 启动；新建 Pad 默认私有（归属创建者）。`deletePad` 的「不能删最后一个 Pad」保护同步放宽。
3. **昵称** — `users` 表新增 `display_name`；`PATCH /api/auth/me` 设置；成员列表与（后续）在线成员展示用昵称区分成员。
4. **成员管理 API** — `GET /api/members`、`POST /api/members/:code/write`、`DELETE /api/members/:code/write`（`X-Admin-Token`）；`GET/POST/DELETE /api/write-access/{status,redeem,release}`。
5. **字数统计重做（参考 Memos / SiYuan）** — 字数 = CJK 字符数 + 英文单词数；阅读时间按中文 400 字/分、英文 200 词/分分别加权；选区统计「选中 N 字 / 共 M 字」；中文文案 + 千分位；输入事件防抖 200ms 避免每次击键全量正则扫描。
6. **回归测试** — 新增 `tests/write-access.test.js`（9 例：open 不误拦、gated 12 条 HTTP 全 403、WS 4405、口令兑换、admin 授予/撤销、主动释放、成员列表鉴权、只读路径开放、昵称）。测试启动器适配零 Pad：`startServer` 按需 bootstrap 公开 Pad，且 `gated` 场景经 admin token 创建。

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
