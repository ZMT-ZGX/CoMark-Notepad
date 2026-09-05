# 竞品分析与改进路线图

> 分析对象：**CoMark-Notepad v1.2.0**（局域网实时协作 Markdown 记事本 + 文件共享 + 文件转 Markdown）
> 数据快照：**2026-09-02**（GitHub REST API 实测）
> 本报告只做分析与建议，**不修改任何源代码**；所有差距点均附本项目 `file:line` 代码证据，便于直接落地。

---

## 1. 执行摘要

CoMark 处在一个"两头都不占"的独特位置：比它重的（Outline / Docmost / AFFiNE）有完整团队权限与 CRDT，但需要 Postgres + Redis + S3 三件套；比它轻的（flatnotes / SilverBullet）单进程、无数据库，但**不做多人实时协同**。CoMark 用「单进程 + SQLite + diff-match-patch patch 同步」把两者拼接起来，这是它最真实的差异化——**局域网/单机一键起、零依赖的"带协同的记事本"**。

对比 10 个同类项目后的结论是：**架构选型没有走弯路，短板集中在"协同的正确性上限"和"大文档下的性能"两处，其次是工程化配套（文档/测试/可观测）的成熟度。** 前者决定产品能走多远，后者决定别人愿不愿意贡献与自托管。

### Top 改进项速览

| # | 优先级 | 问题 | 一句话做法 | 影响面 |
|---|--------|------|-----------|--------|
| P0-1 | P0 | `patch-ack` 回传全量正文，每次击键双份全量序列化 | ack 只回 `textVersion` + `seq` | 大文档协作带宽/CPU |
| P0-2 | P0 | FTS 触发器每次击键全量重建 trigram 索引 | 改节流批量刷新 / 外部表定时同步 | 击键延迟、写放大 |
| P0-3 | P0 | 图片 base64 内嵌进正文，参与 diff/FTS/广播 | 改走 `/api/upload` 插 `![](url)` | 文档膨胀、补丁体积 |
| P0-4 | P0 | 文件 72h TTL 无条件硬删，长期协作附件会静默消失 | 改为最后访问续期 + 回收站宽限 | 数据安全 |
| P0-5 | P0 | 删 Pad / 清文件时同步 `unlinkSync` 阻塞事件循环 | 改 `fs.promises.unlink` + `Promise.all` | 请求尾延迟 |
| P1-1 | P1 | 只有在线人数，没有"谁在编辑、编辑到哪" | 新增 `presence` 消息 + 远端光标 | 协作可感知性 |
| P1-6 | P1 | 缺 CONTRIBUTING / SECURITY / ARCHITECTURE / 接口规范 | 补齐四份文档 + 截图 | 外部贡献与信任 |

---

## 2. 对比方法论

### 2.1 相关度排序因子

CoMark 的赛道可拆成五个可量化因子，权重按"是不是同一件事"递减：

| 因子 | 权重 | 含义 |
|------|------|------|
| **多人实时协同** | 40% | 是否以「多端同时编辑同一文档」为核心卖点 |
| **Markdown 原生** | 20% | Markdown 是一等公民还是富文本/块结构的附属 |
| **自托管轻量度** | 20% | 能否单进程 / 单容器 / 无外部依赖跑起来 |
| **技术栈可比性** | 10% | Node/TypeScript 生态，工程实践可直接借鉴 |
| **目标场景重合** | 10% | 小团队 / 局域网 / 快速记录，而非企业级知识库 |

评分结果（满分 100）：HedgeDoc 94 · CodiMD 90 · Etherpad 82 · Docmost 80 · CryptPad 78 · Outline 74 · AFFiNE 74 · SilverBullet 70 · SiYuan 64 · Memos 62。

**排序说明**：SilverBullet 与 Memos 星数远高于 HedgeDoc，但它们**不做多人实时协同**（SilverBullet 是单人离线同步，Memos 是个人速记时间线），相关度因子权重最高的那一项得分为低，因此排在后面——星数衡量的是流行度，不是可借鉴性。

### 2.2 数据来源与口径

- 星数 / fork / 语言 / 许可证 / 最近推送：GitHub REST API `https://api.github.com/repos/{owner}/{repo}`，**2026-09-02 快照**。
- 技术栈细节：各项目官方文档与公开资料。凡未在本次调研中逐行核验的（如编辑器内部实现），在表格中标注「公开资料」，避免把推测当结论。
- 本项目短板：直接阅读本仓库源码得到，均标注 `file:line`。

---

## 3. 竞品逐项速览（Top 10，按相关度降序）

### 1. HedgeDoc · ★7,390 · 相关度 94

- **定位**：开源实时协作 Markdown 笔记，自托管领域的事实标准（原 CodiMD）。
- **活跃度**：fork 591 / open issues 281 / 最近推送 2026-09-01；AGPL-3.0；TypeScript。
- **技术栈**：1.x 为 Express + CodeMirror，协同走 **OT（ot.js）**；**2.0 正在完全重写为 NestJS + React + Yjs/CRDT**，数据库支持 PostgreSQL / MySQL / SQLite（公开资料）。1.x 已进入维护状态，不再接新特性。
- **对 CoMark 的启示**：⚠️ **最重要的信号**——这个赛道最有代表性的项目正在把协同内核从 OT 换成 CRDT。CoMark 的 patch 方案属于"比 OT 更轻"的一档，上限更低；HedgeDoc 的选择说明这条路迟早要走，但**不必现在走**（见 P2-6 双轨评估）。

### 2. CodiMD · ★10,138 · 相关度 90

- **定位**：HedgeDoc 的前身，同赛道的历史演化样本。
- **活跃度**：fork 1,123 / open issues 351 / **最近推送 2025-10-02**；AGPL-3.0；JavaScript。
- **技术栈**：Express + CodeMirror + OT，MySQL/PostgreSQL/SQLite。
- **对 CoMark 的启示**：反面教材。issue 积压 351、近一年无推送，说明**单靠"功能齐全"留不住社区**。工程化配套（CI、贡献指南、响应速度）比功能列表更能决定项目生命力——这正是 CoMark 的 P1-6 要补的。

### 3. Etherpad · ★18,517 · 相关度 82

- **定位**：实时协作文档编辑器鼻祖，协同算法的教科书。
- **活跃度**：fork 3,040 / open issues **仅 26**（治理极佳）/ 最近推送 2026-09-01；Apache-2.0；TypeScript。
- **技术栈**：Node.js + Socket.IO，自研 **EasySync / Changeset OT**（服务端权威 + 客户端变换），300+ 插件生态。
- **对 CoMark 的启示**：
  - **冲突处理范式**：Etherpad 用"服务端保存 revision 历史、客户端基于旧版本变换"实现无冲突合并；CoMark 目前是 `baseVersion` 不匹配**直接拒**（`src/services/padService.ts:194` 一带），再由客户端降级走 HTTP 全量覆盖。这是 CoMark 协作手感的最大天花板。
  - **issue 治理**：26 个 open issue 对 18.5k 星，说明有严格的 triage 流程，值得照搬（见 P1-6）。

### 4. Docmost · ★21,547 · 相关度 80

- **定位**：开源协作 Wiki / 文档平台，Confluence / Notion 替代。
- **活跃度**：fork 1,546 / open issues 325 / 最近推送 2026-09-02；AGPL-3.0；TypeScript（**2023 年才创建，增长极快**）。
- **技术栈**：NestJS + React + TipTap 编辑器（实时协同为 Yjs/Hocuspocus 类方案，公开资料），**PostgreSQL + Redis**。
- **对 CoMark 的启示**：
  - **分层架构标杆**：NestJS 的模块化 + DI，与 CoMark 的 `src/services`、`src/routes`、`src/db` 分层思路一致，**说明 CoMark 的后端分层方向是对的**，缺的是模块边界的显式契约（见 5.2）。
  - **反面参照**：它要求 PG + Redis 三件套，自托管门槛明显高于 CoMark 的「一个 SQLite 文件」。**这是 CoMark 应该守住并放大的护城河**，不要为了对齐功能而引入外部依赖。

### 5. CryptPad · ★7,876 · 相关度 78

- **定位**：端到端加密（E2EE）的实时协同办公套件。
- **活跃度**：fork 842 / open issues 393 / 最近推送 2026-09-01；AGPL-3.0；JavaScript。
- **技术栈**：自研 **ChainPad**（OT 变体）实时引擎，服务端零知识，文档以加密 blob 存储。
- **对 CoMark 的启示**：
  - **威胁建模范式**：CryptPad 把"服务端不可信"写进架构。CoMark 的 `SESSION_SECRET` / unlock token / 日志脱敏已经做得不错（AGENTS.md 有明确约束），但**缺少一份公开的 SECURITY.md 说明威胁模型与披露流程**，用户无法自行判断风险（P1-6）。
  - **反面参照**：E2EE 与全文搜索天然冲突（服务端无法索引明文）。CoMark 选了「服务端可索引 → 有 FTS5 全文搜索」，这是**正确的取舍**，不必跟进加密。

### 6. Outline · ★40,421 · 相关度 74

- **定位**：团队知识库，实时协同 + Markdown 兼容。
- **活跃度**：fork 3,533 / open issues 84 / 最近推送 2026-09-02；自定义许可（非标准 OSI 许可）；TypeScript。
- **技术栈**：React + MobX + Node/TS，编辑器基于 ProseMirror，自托管需 Postgres + Redis + S3 + OIDC 登录。
- **对 CoMark 的启示**：
  - **权限模型**：三级（工作区 / 集合 / 文档）+ 分享链接 + 成员角色。CoMark 的三级模型（公开 / 受邀 / 管理员）在**单人局域网场景够用**，但一旦多人共用就会出现 README 已承认的"公开 Pad 任意登录用户可删他人文件"问题（P2-1 的回收站可低成本缓解）。
  - **文档质量**：Outline 有完整的自托管文档、API 文档、贡献指南、安全说明——这是 CoMark 差距最大的一维（见 5.3）。

### 7. AFFiNE · ★72,107 · 相关度 74

- **定位**：本地优先（local-first）知识库，Notion + Miro 替代。
- **活跃度**：fork 5,218 / open issues 722 / 最近推送 2026-08-28；自定义许可；TypeScript + Rust。
- **技术栈**：**CRDT**（Yjs / 自研 OctoBase），本地优先 + 可选同步，块结构数据模型。
- **对 CoMark 的启示**：CRDT 路线的终局形态。它证明了"离线编辑 + 多端合并"必须用 CRDT 而非 patch。CoMark 当前的离线队列（`public/js/text-sync.js`）只是"暂存后按序重放"，**重连失败即 nack**——这正是 CRDT 要解决的问题。评估见 P2-6。

### 8. SilverBullet · ★5,981 · 相关度 70

- **定位**：自托管、**离线优先**的 Markdown 工作区，Lua 可脚本化。
- **活跃度**：fork 474 / open issues 335 / 最近推送 2026-09-01；MIT；TypeScript（服务端已迁移 Rust）。
- **技术栈**：PWA + **IndexedDB 保存整个 space 的完整副本**，Sync 引擎在线时持续同步；Markdown 文件即数据源。
- **对 CoMark 的启示**：✅ **最值得直接抄的一项**。CoMark 目前**没有 Service Worker、没有 manifest**（`public/` 下 ES Modules 原样提供，靠手动 `?v=17` 破缓存），断网时只有"离线横幅 + localStorage 队列"，**页面刷新即失联**。SilverBullet 的 PWA 方案（静态资源 SW 缓存 + IndexedDB 数据副本）可直接移植，且不需要引入前端框架（P2-2）。

### 9. SiYuan · ★46,116 · 相关度 64

- **定位**：隐私优先、自托管的个人知识管理，块级引用 + 双向链接。
- **活跃度**：fork 2,977 / open issues 80 / 最近推送 2026-09-02；AGPL-3.0；TypeScript + Go + SQLite。
- **技术栈**：SQLite 存储 + 全文搜索 + 附件管理，支持 Docker 自托管、WebDAV / S3 同步。
- **对 CoMark 的启示**：
  - **同存储引擎的对标**：同样 SQLite + FTS，SiYuan 做了块级索引、附件独立目录、多端同步。CoMark 可以借鉴其**附件与正文分离**的做法——这正好对应 P0-3（图片不应内嵌进正文参与 FTS 索引）。
  - **数据模型**：SiYuan 的"块"让搜索能精确定位；CoMark 的 FTS 表里 `title` 列恒为空（见 5.2），搜索只能命中正文。

### 10. Memos · ★62,724 · 相关度 62

- **定位**：自托管短笔记时间线，快速捕获场景。
- **活跃度**：fork 4,713 / open issues **仅 46** / 最近推送 2026-09-01；MIT；Go + React + **SQLite**。
- **技术栈**：Go 后端 + React 前端 + SQLite，REST/gRPC 双 API，单二进制单容器部署。
- **对 CoMark 的启示**：
  - **社区运营与工程标杆**：62.7k 星却只有 46 个 open issue，靠的是极快的 issue 响应 + 清晰的发布节奏 + 完善的文档。
  - **单文件部署体验**：一个二进制 + 一个 SQLite 文件——CoMark 已是这个形态（`DATA_DIR` + SQLite），**在 README 里应把"零依赖单文件自托管"作为首要卖点**（当前 README 把 Docker Compose + Caddy 放在最前，反而抬高了初次接触的心理门槛）。

---

## 4. 五维对比矩阵

### 4.1 对比矩阵

| 项目 | 星数 | 协同内核 | 自托管依赖 | 主栈 | 许可 | 文档质量 | 社区活跃度 |
|------|------|---------|-----------|------|------|---------|-----------|
| **CoMark（本项目）** | — | diff-match-patch（无 OT/CRDT） | **无（SQLite 单文件）** | TS/Express/原生 JS | MIT | 中（README 详，四件套缺） | 起步 |
| HedgeDoc | 7,390 | OT → **Yjs/CRDT（2.0）** | SQLite/PG/MySQL | TS/Express→NestJS | AGPL-3.0 | 高（docs 站 + 配置手册） | 高 |
| CodiMD | 10,138 | OT | SQLite/PG/MySQL | JS/Express | AGPL-3.0 | 中高 | **低（近 1 年无推送）** |
| Etherpad | 18,517 | **EasySync OT** | 多 DB 可选 | TS/Node | Apache-2.0 | 高（docs.etherpad.org） | 高（issues 治理极佳） |
| Docmost | 21,547 | Yjs + TipTap | **PG + Redis** | TS/NestJS/React | AGPL-3.0 | 中高 | **很高（2023 起爆增）** |
| CryptPad | 7,876 | ChainPad（OT 变体） | 文件系统 | JS/Node | AGPL-3.0 | 高 | 中高（issues 393 偏高） |
| Outline | 40,421 | ProseMirror + WS 同步 | **PG + Redis + S3 + OIDC** | TS/React/MobX | 自定义 | **很高** | 高 |
| AFFiNE | 72,107 | **CRDT（Yjs/OctoBase）** | PG（可选同步） | TS/Rust | 自定义 | 高 | 很高（issues 722） |
| SilverBullet | 5,981 | **Sync 引擎（单人离线）** | 无（Markdown 文件） | TS/Rust | MIT | 高（站点即文档） | 中高 |
| SiYuan | 46,116 | 同步（非实时协同） | SQLite | TS/Go | AGPL-3.0 | 高 | 高（issues 仅 80） |
| Memos | 62,724 | 无（个人速记） | 无（SQLite 单文件） | Go/React | MIT | 高 | **很高（issues 仅 46）** |

### 4.2 各维度小结

**① 功能特性**：CoMark 的组合（实时协同 + 文件共享 + **文件转 Markdown**）在同类里**独一份**——10 个项目无一提供"上传 PDF/DOCX 一键转 Markdown 进笔记"这条链路，这是真正的差异化，应在文档中前置放大。缺的是协同类产品的标配：在线成员/远端光标、历史版本、回收站。

**② 代码结构**：CoMark 的后端分层（`routes` → `services` → `db`/`store`）与 Docmost 的 NestJS 分层同构，方向正确、且比 CodiMD 的遗留代码干净。差距在**边界契约**：路由里存在直接查库与 N+1（`src/app.ts:134-151`）、schema 里有死列、删除路径有同步阻塞 IO。

**③ 文档质量**：这是差距最大的一维。10 个项目中 8 个有独立文档站或完整 docs 目录 + 贡献指南；CoMark 只有 `DEPLOYMENT.md`。README 本身写得很好（特性、快捷键、ACL、API、已知限制齐全），但**从"能跑起来"到"能参与进来"的中间层缺失**。

**④ 社区活跃度**：对标项目里治理最好的两个（Etherpad 26 issues、Memos 46 issues）证明了 issue 响应速度决定项目观感。反面是 CodiMD：351 issues + 停更。CoMark 目前测试覆盖扎实（72 集成 + 15 E2E），**基础是好的，缺的是公开的贡献路径与 issue 模板**。

**⑤ 技术栈选型**：CoMark 的选型与其定位高度自洽——SQLite 单文件 + 单进程 + 零构建前端，自托管门槛全场最低。**不建议为了对齐 Docmost/Outline 的功能而引入 Redis/PG**；反过来应该继续加固"一个文件带走全部数据"的体验。真正需要评估的技术升级只有一个：协同内核从 patch 演进到 CRDT（P2-6）。

---

## 5. 差距分析

### 5.1 缺失的关键功能

| 缺失项 | 代码/行为证据 | 竞品参照 | 影响 |
|--------|--------------|---------|------|
| **无冲突合并（OT/CRDT）** | `padService.applyPatch` 用乐观锁：`baseVersion !== pad.textVersion` 直接返回 `ok:false`（`src/services/padService.ts:156-260`）；客户端收到 `patch-nack` 后重置影子、放弃 WS 重放，降级为条件 HTTP `PUT`（`src/ws/index.ts:204-217`、`public/js/text-sync.js:538-570`） | Etherpad EasySync 服务端变换；HedgeDoc 2.0 → Yjs | 同位置并发编辑后到者被拒，README 已承认 |
| **协作者光标 / 在线成员列表** | 仅有 `#online-count` 数字（`src/ws/index.ts:226-229`），无用户标识、无选区广播 | Docmost / Outline presence + 远端光标 | 多人协作时"不知道谁在改哪" |
| **历史版本 / 回收站** | Pad 删除即硬删；无版本表（`src/db/sqlite.ts:11-67` schema 中无 `pad_versions` / `deleted_*`） | Outline 版本历史、Docmost 页面历史 | 误删不可恢复，无 diff 回溯 |
| **PWA / 真离线** | 无 `manifest.json`、无 Service Worker；静态资源靠手动 `?v=17` 破缓存 | SilverBullet PWA + IndexedDB 全量副本 | 断网刷新即失联，移动端无法安装到桌面 |
| **编辑器增强** | 纯 `<textarea>`，无工具栏；预览仅 marked + DOMPurify（`public/js/preview.js:37`），无代码高亮 / mermaid / 数学公式 | HedgeDoc（mermaid/图表齐全）、SiYuan | 长文档写作体验弱于同类 |
| **i18n / a11y** | 界面中英混排（中文提示 + 英文 placeholder）；全站仅 2 处 `aria-label`，模态缺 `role="dialog"` / `aria-modal` / 焦点陷阱 | HedgeDoc 多语言（Poeditor 协作翻译） | 非中文用户门槛高；键盘/读屏不可用 |

### 5.2 可改进的代码组织

| 问题 | 位置 | 说明 |
|------|------|------|
| **FTS 表存在死列** | `src/db/sqlite.ts:69-86` | `pad_search(id, title, content)` 中 `title` 恒为 `''`（`pads` 表无标题列），FTS 一半的字段永远是空的；搜索只能命中正文，无法按标题检索。要么给 `pads` 加 `title`（从首行 `#` 提取），要么从 FTS schema 中移除该列 |
| **缺失索引** | `src/db/sqlite.ts:53-62` | 仅有 `access_grants`(3)、`invitations(creator_code)`、`files(pad_id)`。缺 `pads(owner_user_id)`、`pads(creator_code)`（每次 ACL 过滤全表扫）、`files(owner_user_id)`、`files(created_at)`（TTL 清理全表扫） |
| **路由层直接查库** | `src/app.ts:134-151` | `/api/search` 在路由里直接 `db.pads.findByIdMeta` + `db.searchSnippet`，绕过了 `padService` 门面；AGENTS.md 明确要求路由不得直接访问 `db` |
| **模块边界无契约** | `src/store/` vs `src/services/` | `DataStore` 门面与 `padService` 职责有重叠（`getState` 里直接 `this.store.findPadById`），ACL 逻辑散落在 service 与 middleware 两处 |
| **同步阻塞 IO** | `src/server.ts:72`、`src/services/padService.ts:382`、`src/services/fileService.ts:329,361` | 删除/清理路径上的 `fs.unlinkSync`（单文件删除、清 Pad 文件、删 Pad、TTL 清理各一处），大批量清理时阻塞事件循环 |
| **前端分发耦合** | `public/js/ws.js:90-140` | 13 种消息类型塞在一个 `switch` 里，新增消息类型需改核心文件；缺消息注册表/事件总线 |
| **前端无构建、缓存手工化** | `public/` 原样提供 ES Modules | 版本号 `?v=N` 手动维护，漏改即缓存污染；无 tree-shaking / 压缩，首屏随模块数线性增长 |

### 5.3 文档完善程度

**已有（做得好的部分）**：README 覆盖特性、快捷键表、环境变量表、协同模型图、ACL 权限矩阵、API 列表、项目结构树、已知限制、版本 Changelog；`docs/DEPLOYMENT.md` 自托管运维手册；生产启动自检告警。

**缺失（按补齐收益排序）**：

| 缺失文档 | 为什么重要 | 参照 |
|---------|-----------|------|
| **CONTRIBUTING.md** | 外部贡献者无从下手：无本地开发流程、无提交规范（已有 simple-git-hooks 但未说明）、无 PR 模板 | Memos / HedgeDoc 均有 |
| **SECURITY.md** | 项目涉及会话令牌、unlock token、CSRF、CSP，但无威胁模型说明与漏洞披露渠道 | CryptPad 的安全模型文档 |
| **ARCHITECTURE.md** | 协同协议（patch/nack/ack 时序）、ACL、FTS 设计只散落在 README 与代码注释里 | Docmost 的模块化文档 |
| **OpenAPI / 接口规范** | API 目前是散文式列表，无请求/响应 schema、无错误码表；已有 Zod schema，可直接生成 | Memos 的 REST/gRPC API 文档 |
| **截图 / 演示 GIF** | README 零视觉素材，自托管用户无法快速判断产品形态 | 10 个项目全部首页带截图/演示 |
| **README 卖点顺序** | 快速开始首选 `docker compose up`，掩盖了"npm install && npm run dev 一条命令、零外部依赖"这一最大优势 | Memos 的单二进制部署叙事 |

### 5.4 性能优化点

| # | 问题 | 证据 | 优化方向 |
|---|------|------|---------|
| 1 | **每次击键双份全量序列化** | `patch` 广播帧携带 `text`（`src/services/padService.ts:246-258`），`patch-ack` **又**回传 `text`（`src/ws/index.ts:196-203`） | ack 只需 `textVersion` + `seq`（客户端影子本就是它自己算的），可省掉一半出站字节与一次 100KB JSON 序列化 |
| 2 | **FTS 触发器每击键全量重建** | `pad_au AFTER UPDATE OF text` → `UPDATE pad_search SET content = NEW.text`（`src/db/sqlite.ts:84-86`），叠加 better-sqlite3 同步写 | 改为节流批量刷新（如 2s 合并一次）或 contentless external 表 + 定时同步；搜索延迟几秒对用户无感 |
| 3 | **N+1 查询** | `getState` 对每个 file 调 `canAccessFile → findPadById`（`src/services/padService.ts:133-143`）；`/api/search` 对每条命中再 `findByIdMeta` + `searchSnippet`（`src/app.ts:134-151`） | 预取 pad 集合构建 `Map<id, pad>` 一次查完 |
| 4 | **图片 base64 内嵌正文** | `public/js/text-sync.js:660-694` 把 ≤56KB 的 data URL 写进 `pads.text` | 改走 `/api/upload` 后插入 `![alt](/api/files/:id)`：正文瘦身 → patch 变小 → FTS 索引变小 → 广播变小，四处同时受益 |
| 5 | **同步阻塞删除** | 四处 `fs.unlinkSync`：`src/server.ts:72`（TTL 清理）、`src/services/padService.ts:382`（删 Pad）、`src/services/fileService.ts:329`（删单个文件）、`:361`（清空 Pad 文件） | 改 `fs.promises.unlink` + `Promise.all` |
| 6 | **广播风暴** | `broadcast.toAll` 对 `pad-created/updated/deleted` 全量广播（`src/ws/broadcast.ts:27-45`），每个客户端随即重拉 `GET /api/state` | 按 userId / 授权范围定向推送 |
| 7 | **重连退避无抖动** | `public/js/ws.js:166` 固定 `min(2000 * 2^n, 30000)`，无 jitter | 加随机抖动，避免断网恢复时所有客户端同时重连造成惊群 |
| 8 | **IME 组字期积压** | `composing=true` 时 `pump()` 直接 return（`public/js/text-sync.js:266`） | 长时间组字会累积未发送编辑，可考虑组字结束后一次性 flush（当前依赖 nack 兜底） |

### 5.5 用户体验提升方向

1. **协作可感知**（P1）：在线成员头像 + 远端光标/选区高亮。当前只有人数，多人同时编辑时无法判断"他在改哪一段"，是所有竞品都具备的基础能力。
2. **附件生命周期可控**（P0）：`FILE_TTL_HOURS=72` 是**创建后无条件删除**（`src/server.ts:64-84`），一个挂在长期 Pad 上的附件会在 3 天后静默消失，且用户无提示。应改为最后访问续期 + 到期前提示 + 回收站宽限期。
3. **冲突反馈友好化**（P1）：nack 发生时用户只看到文本被重置，无任何提示。应在 UI 上给出"与远端冲突，已合并/已保留你的版本"的轻量提示（不可使用阻塞弹窗）。
4. **断网体验**（P2）：当前只有黄色横幅。应区分「弱网重连中 / 离线队列待同步 N 条 / 已同步」三态，并暴露"立即重试"按钮。
5. **编辑器与预览**（P2）：工具栏（加粗/标题/列表/链接/代码）、代码高亮、任务列表、表格、mermaid、数学公式；预览区滚动同步。
6. **导出与迁移**（P2）：当前仅支持导出当前 Pad 单个 `.md`（`public/js/export.js:23`）。应支持全量导出 zip（含附件）、导入 Markdown 文件夹。
7. **移动端**（P2）：已有手势切 Pad 与二维码，但无 PWA 安装、无安全区适配验证、文件列表在窄屏下的操作密度偏高。
8. **首次体验**（P1）：新用户打开即见空白 textarea，无人引导。应有 30 秒上手指引（新建 Pad → 扫码 → 邀请）。

---

## 6. 改进路线图（按优先级）

**判定标准**：
- **P0** — 影响数据安全、协作正确性或大文档性能的缺陷，应在本迭代内修复。
- **P1** — 高频体验与工程配套，决定项目能否吸引外部用户与贡献者。
- **P2** — 差异化增强与长期演进，可做技术预研。

### P0 · 立即修复

#### P0-1 `patch-ack` 瘦身：去掉回传的全量正文

- **做法**：`src/ws/index.ts:196-203` 的 `patch-ack` 只保留 `{ type, textVersion, seq }`；客户端 `patch-ack` 处理分支不再用回传 text 覆盖影子（影子由发送前的 `lastSyncedText` 维护）。仅 `patch-nack` 保留全量 text（它承担重同步职责，不可省）。
- **涉及文件**：`src/ws/index.ts`、`public/js/text-sync.js`、`src/types.ts`（`WsMessage` union）
- **验收标准**：3 个客户端、50KB 文档、连续输入 200 字符场景下，服务端出站字节数下降 ≥45%；`tests/smoke.test.js` 的 patch ack 用例断言 `text` 字段已移除；E2E `collaboration` 全绿。
- **工作量**：约 0.5 天

#### P0-2 FTS 索引同步改为节流批量

- **做法**：移除 `pad_au` 触发器（`src/db/sqlite.ts:84-86`），改为：写 `pads.text` 时记录脏 padId 到内存 Set，定时器每 2s 批量 `UPDATE pad_search SET content = ... WHERE id = ?`；进程退出前 flush。提供配置项 `FTS_SYNC_INTERVAL_MS`（默认 2000）。
- **涉及文件**：`src/db/sqlite.ts`、`src/config.ts`、`src/services/padService.ts`、`src/server.ts`（定时器注册与优雅关闭 flush）
- **验收标准**：新增集成测试——连续 100 次 `applyPatch` 后等待 2.5s，`/api/search` 能命中最新内容；压测脚本显示 100KB 文档连续输入的 P95 写延迟下降可观测；`pad_ai`/`pad_ad` 触发器保留。
- **工作量**：约 1 天

#### P0-3 图片粘贴改走文件上传

- **做法**：`public/js/text-sync.js:660-694` 不再写 data URL，改为调用现有 `POST /api/upload`（加锁 Pad 走 `X-Pad-Token` header），拿到 `file.id` 后插入 `![alt](/api/files/:id)`。保留 >2MB 拒绝逻辑；上传失败时回退到原有的 data URL 路径并提示。
- **涉及文件**：`public/js/text-sync.js`、`public/js/files.js`、`public/js/server.js`
- **验收标准**：粘贴 1MB 截图后，`pads.text` 长度增量 < 100 字符（原为 ~1.37M 字符）；生成的一次 patch < 1KB；图片在所有客户端可见；现有 E2E「粘贴图片同步」用例改造后通过。
- **工作量**：约 1 天（含历史数据兼容：已存在的 data URL 不迁移，仅新粘贴生效）

#### P0-4 文件 TTL 改为最后访问续期 + 回收站宽限

- **做法**：`files` 表增加 `last_accessed_at`（迁移脚本默认值 = `created_at`）；`GET /api/files/:id` 与 `/api/state` 命中时更新；`ttlMs` 判定基于 `last_accessed_at`。到期文件先标记 `expires_at`（进入 24h 宽限期、UI 显示"即将过期"），宽限期结束才真正删除。
- **涉及文件**：`src/db/sqlite.ts`（schema + 迁移）、`src/db/files.ts`、`src/services/fileService.ts`、`src/server.ts:64-84`、`public/js/files.js`
- **验收标准**：新增测试——文件在 TTL 中途被访问则不被清理；未被访问的文件到期后进入宽限期而非立即删除；宽限期结束后才 `unlink`。旧数据库升级后 `last_accessed_at` 有值。
- **工作量**：约 1.5 天

#### P0-5 删除路径改为异步 IO

- **做法**：四处同步删除统一改异步——`src/server.ts:72`（TTL 清理循环）、`src/services/padService.ts:382`（删 Pad 时清理附件）、`src/services/fileService.ts:329`（删单个文件）、`:361`（清空 Pad 文件）。改为 `await Promise.all(items.map(f => fs.promises.unlink(...).catch(() => {})))`。保证顺序：先删 DB 记录，再删文件，失败仅记 `logger.warn` 不回滚。
- **涉及文件**：`src/server.ts`、`src/services/padService.ts`、`src/services/fileService.ts`
- **验收标准**：清空 500 个文件的 Pad 时，事件循环延迟（`perf_hooks` 采样）无 >100ms 阻塞；删除失败不影响 HTTP 响应。
- **工作量**：约 0.5 天

### P1 · 近期补齐

#### P1-1 在线成员与远端光标（presence）

- **做法**：新增 WS 消息 `{ type:'presence', padId, userId, displayName, caretStart, caretEnd }`；服务端不持久化，仅在 `connections.ts` 里挂在 ws 上并转发同 Pad 其他客户端；客户端节流 100ms 发送，用绝对定位的 CSS 伪元素渲染远端光标（不引框架）。
- **涉及文件**：`src/types.ts`（`WsMessage` union）、`src/ws/index.ts`、`src/ws/connections.ts`、`public/js/ws.js`、新增 `public/js/presence.js`、`public/style.css`
- **验收标准**：两个浏览器同时打开同一 Pad，各自能看到对方昵称与光标位置；断开一方后光标在 5s 内消失；不破坏 `MAX_WS_PATCHES_PER_WINDOW` 限流（presence 单独计数）。
- **工作量**：约 2 天

#### P1-2 消除 N+1 查询

- **做法**：`padService.getState`（`src/services/padService.ts:133-143`）预取 `padMap = new Map(pads.map(p => [p.id, p]))` 传给 `canAccessFile`；`/api/search` 把 pad 元数据查询提到 `map` 之前，一次 `WHERE id IN (...)` 取回。
- **涉及文件**：`src/services/padService.ts`、`src/app.ts`、`src/db/pads.ts`（新增 `findManyMetaByIds`）
- **验收标准**：`getState` 的 SQL 语句数从 `O(files)` 降为 `O(1)`（用 better-sqlite3 的 statement 计数或日志断言）；`/api/search` 返回 50 条结果时查询数 ≤ 3。
- **工作量**：约 0.5 天

#### P1-3 补齐缺失索引

- **做法**：`src/db/sqlite.ts` 增加 `idx_pads_owner`、`idx_pads_creator`、`idx_files_owner`、`idx_files_created_at`（TTL 清理用）。
- **验收标准**：`EXPLAIN QUERY PLAN` 显示 TTL 清理与 ACL 过滤走索引而非全表扫；迁移在已有数据库上幂等。
- **工作量**：约 0.5 天

#### P1-4 FTS `title` 列处置

- **做法**：二选一——（推荐）给 `pads` 加 `title` 列，保存时从正文首行 `# ` 提取，`pad_ai`/`pad_au` 同步写入 FTS `title`；或（最小改动）从 FTS schema 移除 `title` 列。选前者可顺带解决"Pad 列表只显示 'Pad 3'"的问题。
- **涉及文件**：`src/db/sqlite.ts`、`src/services/padService.ts`、`public/js/pads.js`
- **验收标准**：搜索能命中 Pad 标题；Pad 列表展示真实标题；FTS 无空列。
- **工作量**：约 1 天

#### P1-5 Pad 事件定向广播

- **做法**：`src/ws/broadcast.ts:27-45` 的 `toAll` 用于 pad 事件时，改为遍历连接并按 `ws.userId` + 授权范围过滤（复用 `canAccessPad` 的判定输入），只对命中者推送；未命中者不发，避免其重拉 `/api/state`。
- **涉及文件**：`src/ws/broadcast.ts`、`src/ws/connections.ts`、`src/services/padService.ts`
- **验收标准**：10 个连接、1 个 Pad 变更场景下，`/api/state` 请求数从 10 降到实际有权限的连接数。
- **工作量**：约 1 天

#### P1-6 文档四件套 + 视觉素材

- **做法**：新增 `CONTRIBUTING.md`（本地开发、测试、提交规范、PR 模板）、`SECURITY.md`（威胁模型、支持的版本、披露邮箱）、`ARCHITECTURE.md`（协同时序图、ACL、FTS、WS 协议）、`docs/API.md`（由 Zod schema 生成请求/响应表 + 错误码）；README 增加截图/演示 GIF，并把"零依赖单命令启动"提到快速开始首位。
- **涉及文件**：新增 4 个文档；`README.md` 调整顺序与插图
- **验收标准**：新贡献者按 CONTRIBUTING 独立跑通 `npm test`；API 文档覆盖全部现有端点；README 首屏含至少 2 张截图。
- **工作量**：约 2 天

#### P1-7 静态资源缓存自动版本化

- **做法**：启动时计算 `public/` 下 JS 文件内容 hash（或取 mtime 最大值）注入模板，替换手写 `?v=17`。零构建前提下保持简单。
- **涉及文件**：`src/app.ts`、`public/index.html`
- **验收标准**：修改任一前端文件后重启，浏览器拉取到新版本，无需改代码。
- **工作量**：约 0.5 天

### P2 · 差异化增强

| 编号 | 项目 | 做法要点 | 涉及文件 | 验收标准 | 工作量 |
|------|------|---------|---------|---------|--------|
| P2-1 | **历史版本 + 回收站** | 新增 `pad_versions(id, pad_id, text, text_version, created_at, author_code)`，写 patch 时按"距上次 ≥5min 或版本数 <50"节流落快照；删除 Pad / 文件改为软删（`deleted_at`）+ 30 天清理任务 | `src/db/sqlite.ts`、新增 `src/services/versionService.ts`、`src/routes/pads.ts`、`public/js/pads.js` | 可回滚到任一快照；误删 30 天内可恢复；软删记录不出现在常规列表 | 3 天 |
| P2-2 | **PWA 离线** | 新增 `manifest.json`（图标、主题色、`display: standalone`）+ Service Worker 预缓存静态资源（stale-while-revalidate）；Pad 正文快照写 IndexedDB，供断网刷新后只读查看 | 新增 `public/manifest.json`、`public/sw.js`、`public/js/core.js` | Lighthouse PWA 可安装；断网刷新后页面与最近正文可读；SW 更新不导致白屏 | 2 天 |
| P2-3 | **编辑器与预览增强** | textarea 上方加工具栏（操作选区、不改动 patch 逻辑）；预览加 highlight.js（本地 vendor）、mermaid、任务列表、表格样式、滚动同步 | 新增 `public/js/toolbar.js`、`public/js/preview.js`、`public/vendor/`、`public/style.css` | 工具栏操作产生的内容变化经 patch 正常同步；离线可用（vendor 本地化，符合 CSP） | 3 天 |
| P2-4 | **i18n + a11y** | 抽出 `public/js/i18n.js` 文案表（中/英）；模态补 `role="dialog"`/`aria-modal`/焦点陷阱/Esc 返回焦点；Pad 列表与文件列表补 `aria-label`、`aria-live` | `public/js/modals.js`、`public/js/pads.js`、`public/js/files.js`、`public/index.html` | axe-core 无严重违规；键盘可完成全部核心流程 | 2 天 |
| P2-5 | **E2E 补测** | 补齐文件上传/下载、FTS 搜索、邀请兑换、移动端手势、断线重连 flush 五条链路 | `tests/e2e/` | Playwright 全绿；离线重连用例能断言 localStorage 队列被 flush | 2 天 |
| P2-6 | **CRDT（Yjs）演进评估** | **只做技术预研不改生产路径**：在独立分支验证 `y-websocket` + `y-prosemirror`（或保留 textarea 的 `Y.Text`）与现有 patch 通道双轨共存的可行性，输出《迁移可行性报告》：数据模型改造点、SQLite 持久化方案（`ydb` 或存 update blob）、unlock token 与 CRDT 房间鉴权如何结合、回滚策略 | 新增 `docs/crdt-migration-spike.md` | 产出可决策的结论文档（含 PoC 分支链接与性能数据） | 3 天 |

> **P2-6 说明**：HedgeDoc 2.0 与 AFFiNE 都已押注 CRDT，长期看 CoMark 也会走到这一步。但**当前不应直接替换**——patch 方案在"局域网小团队、中低频并发"下完全够用，且 CoMark 的差异化在自托管轻量与文件转换，不在协同算法本身。预研的价值是把"什么时候必须换"变成一个**有数据支撑的决策点**，而不是被动等到用户抱怨冲突。

---

## 7. 附录

### 附录 A · 备选项目（未进 Top 10 及原因）

| 项目 | 星数 | 语言 | 许可 | 最近推送 | 说明 |
|------|------|------|------|---------|------|
| **Rustpad** | 4,075 | Rust + TS | MIT | 2025-02-02 | 极简协同编辑器，OT 算法、**无数据库**、文档临时存储。是"协同内核最小实现"的最佳代码教材（服务端仅数百行），但无 Markdown、无持久化，相关度不足 |
| **flatnotes** | 3,208 | Vue + Python | MIT | 2026-08-29 | 无数据库、扁平 Markdown 文件夹 + 全文搜索，单用户。自托管轻量度的标杆，无协同 |
| **TriliumNext/Trilium** | 37,665 | TS | AGPL-3.0 | 2026-09-02 | 个人知识库，层级笔记 + 脚本化。无多人实时协同，与 CoMark 场景重合度低 |
| **Notea** | 2,146 | TS | **无许可证** | 2025-11-15（**已归档**） | 存储在 S3 的自托管笔记。**反面教材**：项目停更且未声明许可证，提醒许可证与维护状态是自托管用户的核心顾虑 |

### 附录 B · 数据快照（2026-09-02，GitHub REST API）

| 项目 | 仓库 | ★ | fork | open issues | 主语言 | 许可 | 创建 | 最近推送 |
|------|------|---|------|-------------|--------|------|------|---------|
| HedgeDoc | hedgedoc/hedgedoc | 7,390 | 591 | 281 | TypeScript | AGPL-3.0 | 2019-03-27 | 2026-09-01 |
| CodiMD | hackmdio/codimd | 10,138 | 1,123 | 351 | JavaScript | AGPL-3.0 | 2015-05-04 | 2025-10-02 |
| Etherpad | ether/etherpad | 18,517 | 3,040 | 26 | TypeScript | Apache-2.0 | 2011-03-26 | 2026-09-01 |
| Docmost | docmost/docmost | 21,547 | 1,546 | 325 | TypeScript | AGPL-3.0 | 2023-08-03 | 2026-09-02 |
| CryptPad | cryptpad/cryptpad | 7,876 | 842 | 393 | JavaScript | AGPL-3.0 | 2014-10-31 | 2026-09-01 |
| Outline | outline/outline | 40,421 | 3,533 | 84 | TypeScript | 自定义 | 2016-05-22 | 2026-09-02 |
| AFFiNE | toeverything/AFFiNE | 72,107 | 5,218 | 722 | TypeScript | 自定义 | 2022-07-31 | 2026-08-28 |
| SilverBullet | silverbulletmd/silverbullet | 5,981 | 474 | 335 | TypeScript | MIT | 2022-02-16 | 2026-09-01 |
| SiYuan | siyuan-note/siyuan | 46,116 | 2,977 | 80 | TypeScript | AGPL-3.0 | 2020-08-30 | 2026-09-02 |
| Memos | usememos/memos | 62,724 | 4,713 | 46 | Go | MIT | 2021-12-08 | 2026-09-01 |
| Rustpad | ekzhang/rustpad | 4,075 | 214 | 19 | Rust | MIT | 2021-06-01 | 2025-02-02 |
| flatnotes | dullage/flatnotes | 3,208 | 209 | 124 | Vue | MIT | 2021-08-03 | 2026-08-29 |
| TriliumNext | TriliumNext/Trilium | 37,665 | 2,530 | 704 | TypeScript | AGPL-3.0 | 2017-05-23 | 2026-09-02 |
| Notea | notea-org/notea | 2,146 | 372 | 56 | TypeScript | 无 | 2021-02-13 | 2025-11-15（已归档） |

### 附录 C · 相关度评分明细

评分口径：各因子 5 分制，加权求和（协同 40% / Markdown 20% / 轻量自托管 20% / 栈可比性 10% / 场景重合 10%）。

| 项目 | 协同 | MD | 轻量 | 栈 | 场景 | **加权总分** |
|------|------|-----|------|-----|------|------------|
| HedgeDoc | 5 | 5 | 4 | 5 | 4 | **94** |
| CodiMD | 5 | 5 | 4 | 4 | 3 | **90** |
| Etherpad | 5 | 2 | 4 | 5 | 4 | **82** |
| Docmost | 5 | 4 | 2 | 5 | 3 | **80** |
| CryptPad | 5 | 3 | 3 | 4 | 3 | **78** |
| Outline | 5 | 4 | 1 | 4 | 3 | **74** |
| AFFiNE | 5 | 3 | 2 | 4 | 3 | **74** |
| SilverBullet | 2 | 5 | 5 | 3 | 4 | **70** |
| SiYuan | 2 | 4 | 4 | 4 | 4 | **64** |
| Memos | 1 | 5 | 5 | 2 | 5 | **62** |

> 注：本表用于说明排序依据，**不是对项目优劣的评价**——Memos 与 SiYuan 的产品完成度远高于 CoMark，只是可借鉴点与本项目当前的痛点重合较少。
