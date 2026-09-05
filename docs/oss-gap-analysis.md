# CoMark-Notepad 开源成熟度对标分析

> 采集时间：2026-09-04 · 采集方式：GitHub REST API（仓库指标 + 根目录清单 + `.github` 清单）+ 本地仓库只读统计
> 结论性质：只读评估，未改动任何源码

---

## 0. 数据基线

### 0.0 分析对象澄清：本地工作区 ≠ GitHub 远端

**本次对比的代码基线是本地工作区，不是 GitHub 上的仓库快照**，二者差异极大：

| 项 | 值 |
|---|---|
| 本地未提交改动 | **57 个文件** |
| 本地最后提交 / 远端最后推送 | 同为 2026-09-01 的同一次提交 |
| 远端实际内容 | v1.2.0 时代代码 + `fix(security): npm audit` |

以下重大工作**全部只存在于本地、尚未推送**：同步协议瘦身（diff-only 帧）、FTS 防抖节流、文件生命周期引用保护、presence、写权限门控、S1–S8 安全专项。

**两个必须分清的后果**：
1. §0.1 的 GitHub 指标（1★ / 0 fork / 无 LICENSE）描述的是**推送状态**；§2/§4/§5 的代码质量结论基于**本地代码**。两者不可混读——远端看起来比本地差得多。
2. **未提交本身就是当前最高优先级风险**：57 个文件的改动只存在于这一台机器上，无远端备份、无 CI 验证。一旦磁盘或工作区故障，本轮全部安全加固与性能优化成果归零。这比报告里任何一条 P1 都更紧急。

### 0.1 本项目（ZMT-ZGX/CoMark-Notepad）

| 指标 | 值 |
|---|---|
| Star / Fork / Open Issues | **1 / 0 / 0** |
| 创建 / 最近推送 | 2026-06-20 / 2026-09-01 |
| 提交数 | 约 36（GitHub API `Link` 尾页推断） |
| GitHub 识别许可证 | **undefined（无 LICENSE 文件）** |
| 仓库体积 / 主语言 | 738 KB / JavaScript |
| 被追踪文件数 | 97 |
| 代码规模 | `src` 6045 行(TS) · `public/js` 3508 行 + `app.js` 89 行 · `tests` 4315 行 |
| 测试 | `node --test` 95 例全过 · E2E 3 个 spec（basic / collaboration / password） |
| CI | 4 job：lint(typecheck+eslint+prettier) / test(Node 18·20·22 + npm audit) / docker / e2e |
| 依赖 | 17 运行时 + 14 开发时 |
| TS 配置 | `strict: true`，target ES2022 |

### 0.2 对标项目（同为自托管笔记/协作文档赛道）

| 项目 | Star | Fork | Issues | 主语言 | 许可证 | 最近推送 |
|---|---|---|---|---|---|---|
| Memos | 62751 | 4713 | 48 | Go | MIT | 2026-09-03 |
| Outline | 40435 | 3536 | 83 | TypeScript | NOASSERTION | 2026-09-03 |
| TriliumNext | 37695 | 2535 | 708 | TypeScript | AGPL-3.0 | 2026-09-03 |
| Docmost | 21573 | 1548 | 327 | TypeScript | AGPL-3.0 | 2026-09-03 |
| Etherpad | 18518 | 3040 | 26 | TypeScript | Apache-2.0 | 2026-09-03 |
| HedgeDoc | 7393 | 591 | 279 | TypeScript | AGPL-3.0 | 2026-09-02 |
| SilverBullet | 5994 | 474 | 335 | TypeScript | MIT | 2026-09-03 |
| **CoMark-Notepad** | **1** | **0** | **0** | JavaScript | **无** | 2026-09-01 |

### 0.3 治理与工程配置文件实测对照

| 文件/配置 | HedgeDoc | Memos | SilverBullet | Docmost | Etherpad | **本项目** |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| LICENSE | ✅ (+`LICENSES/`+REUSE) | ✅ | ✅ | ✅ | ✅ | ❌ **无** |
| CONTRIBUTING.md | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| SECURITY.md | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| CODE_OF_CONDUCT.md | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| PRIVACY.md | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| CODEOWNERS | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| STYLE.md（风格规范） | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| AUTHORS / DCO | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| .editorconfig | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ |
| .nvmrc / .node-version | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| ISSUE_TEMPLATE | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| PR 模板 | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| dependabot / renovate | ✅ renovate | ❌ | ❌ | ❌ | ✅ dependabot | ❌ |
| FUNDING.yml | ❌ | ✅ | ✅ | ❌ | ✅ | ❌ |
| 覆盖率配置 | ✅ codecov.yml | ❌ | ❌ | ❌ | ❌ | ❌ |
| 发版自动化 | ❌ | ✅ release-please | ❌ | ❌ | ❌ | ❌ |
| i18n 工作流 | ❌ | ❌ | ❌ | ✅ crowdin.yml | ❌ | ❌ |
| 插件/扩展机制 | ❌ | ❌ | ✅ `plugs/` `plug-api/` | ❌ | ✅ `local_plugins/` | ❌ |
| 基准测试目录 | ❌ | ❌ | ✅ `bench/` | ❌ | ❌ | ❌ |
| docs/ 目录 | ✅ | ✅ | ✅ | ❌ | ✅ + `doc/` | ✅（6 篇） |

### 0.4 工程工具链实测对照（package.json scripts + devDeps）

| 工具链 | SilverBullet | HedgeDoc | Docmost | **本项目（本地）** |
|---|---|---|---|---|
| 单元测试框架 | **vitest** | 各子包自持 | 各 app 自持（nx） | **仅 `node:test`（后端集成），前端零单测** |
| E2E | playwright | ✅ `test:e2e:ci` | 各 app 自持 | ✅ playwright |
| Lint / 格式化 | biome | **oxlint + oxlint-tsgolint** | eslint | eslint + prettier |
| 性能基准 | **有 `bench` 脚本** | ❌ | ❌ | ❌ |
| CI 专用脚本 | ❌ | **独立 `test:ci` / `test:e2e:ci`** | ❌ | 复用 `npm test` |
| 架构拆分 | 单体 | monorepo（turbo） | **monorepo + 独立 `collab` 协作服务** | 单体单进程 |
| `engines` | `node>=24.13.0, npm>=10` | 未声明 | 未声明 | `node>=18`（CI 实测 18/20/22） |

**由此读出的改进空间**：
- **前端单测缺位**是最确定的差距：SilverBullet / HedgeDoc 都有 vitest 覆盖前端纯逻辑；本项目 3508 行 `public/js`（含 739 行 `text-sync.js`）零单测。
- **无 `bench`**：SilverBullet 把性能基准做成一等公民脚本；本项目所有性能结论仍停留在代码推理层面。
- **无 CI 专用脚本**：HedgeDoc 区分 `test` 与 `test:ci`（CI 里关掉 watch、改 reporter、加并行度）。本项目 CI 直接复用 `npm test`。
- **协作服务未独立**：Docmost 把 `collab` 拆为独立进程。本项目单进程在局域网规模下是**合理取舍**（AGENTS.md 已论证），但意味着未来横向扩展必须重构——建议用 ADR 固化该决策及其失效条件（见 §3 建议 3）。

---

## 1. 社区活跃度 —— 差距最大项

**现状**：1 star、0 fork、0 issue、0 外部贡献者，仓库创建 2.5 个月。

**对标**：同赛道最低量级的 SilverBullet 也有 5994★/474 fork/335 issue；Etherpad 26 个 open issue 对应 3040 fork，说明 issue 数少不等于项目不活跃，而是**有人在用、有人在报**。

**根因判断（非"推广不够"这么笼统）**：
1. **无 LICENSE** → 法律上不可采用。任何企业/个人评估自托管方案时，第一件事是看许可证，看到"无 LICENSE"直接出局。这是 **star 数无法增长的硬阻断**，不是营销问题。
2. **无 CONTRIBUTING / ISSUE_TEMPLATE / PR 模板** → 潜在贡献者没有路径，0 issue 不是"没 bug"，是"没人被邀请来报"。
3. **README 缺 badge**（CI 状态、版本、许可证、Node 版本）→ 仓库列表页无信任信号。
4. 描述定位为 "LAN real-time collaborative notepad"，场景偏窄；对标项目普遍定位为"自托管知识库/团队 wiki"，受众面差一个量级。

**改进建议**
| 优先级 | 动作 |
|---|---|
| **P0** | ~~补 `LICENSE`（MIT 全文），并让 `package.json.license` 与实际一致~~ ✅ 已完成（v1.2.4：LICENSE + README License 章节与 badge） |
| **P0** | 补 `CONTRIBUTING.md`（开发/测试/提交规范）+ `.github/ISSUE_TEMPLATE/` + `PULL_REQUEST_TEMPLATE.md` |
| **P1** | 补 `SECURITY.md`（漏洞披露渠道、支持版本、响应 SLA） |
| **P1** | ~~README 顶部加 badge：CI / License / Node / Release~~ ✅ 已完成（v1.2.4） |
| **P1** | 补 `package.json` 的 `repository` / `homepage` / `author` 字段（当前全为 `undefined`，`npm` 页面无仓库入口） |
| **P2** | 明确 README 首屏定位与截图/GIF（对标项目首页均有产品截图，本项目无） |
| **P2** | 发版自动化（release-please / semantic-release）+ GitHub Release + tag |

---

## 2. 项目结构 —— 单进程单体，缺乏扩展边界

**现状**：`src/` 分层清晰（routes → services → db → store），`public/js` ES Module 拆分 19 个模块，`docs/` 6 篇，`scripts/` 3 个运维脚本。这个结构对**单人 6k 行项目是合理的**。

**对标差距**：
- 所有成功项目都把**可扩展性**写进了目录结构：SilverBullet 的 `plugs/` + `plug-api/`，Etherpad 的 `local_plugins/`，HedgeDoc 的 `markdown-it-plugins/`。本项目的渲染/转换能力（marked、turndown、mammoth、adm-zip、read-excel-file）全部硬编码在 `convert-worker.js` 与 `preview.js`，**新增一种格式必须改核心代码**。
- 根目录混入了 AI 协作残留并被 git 追踪：`code-review.md`、`context.md`。对标项目根目录只有治理文件与源码入口。
- 无 `.editorconfig`、无 `.nvmrc`，跨编辑器/跨 Node 版本一致性靠口头约定。

**改进建议**
| 优先级 | 动作 |
|---|---|
| **P1** | 把 `code-review.md` / `context.md` 移入 `docs/` 或加入 `.gitignore`（AI 协作草稿不应进主仓） |
| **P1** | 补 `.editorconfig` + `.nvmrc`（对齐 CI 的 Node 22） |
| **P2** | 设计最小插件边界：把「文件→Markdown 转换器」抽成注册表（`converters/<ext>.js` + `registerConverter()`），`convert-worker.js` 只做分发。这是**投入最小、收益最大**的扩展点（SilverBullet/Etherpad 的插件生态都从这个点长出来） |
| **P2** | 预留 `docs/adr/` 记录架构决策（为什么选 DMP 不选 CRDT、为什么 SQLite 单文件等），降低新人理解成本 |

---

## 3. 文档完整性 —— README 质量不错，工程文档缺失

**现状（优点应保留）**：README 375 行，覆盖核心特性、快捷键、技术栈、快速开始、生产部署、环境变量、协同模型、访问控制模型、完整 API 列表、测试、项目结构、已知限制、Changelog。`docs/` 含 `DEPLOYMENT.md`、两篇竞品分析（39KB + 10KB，质量很高）、部署方案、重构设计。

**对标差距**：
1. **无 LICENSE 章节的法律效力**（README 第 373 行写"MIT"但无文件支撑）。
2. **无 API 参考文档**：API 只以列表形式写在 README。对标项目（Outline、Docmost）提供独立 API 文档站/OpenAPI。
3. **无架构决策记录（ADR）**：竞品分析写得很深，但**自己为什么这么选型**没有落文档，新人无法判断"这个设计是深思熟虑还是历史包袱"。
4. **无运维可观测性文档**：`DEPLOYMENT.md` 有部署，但缺监控指标、日志字段说明、备份恢复演练、故障排查手册。
5. **无 CONTRIBUTING/开发者文档**：本地如何起环境、如何跑单测/E2E、代码风格，全靠 `AGENTS.md`（面向 AI，不面向人）。

**改进建议**
| 优先级 | 动作 |
|---|---|
| **P0** | ~~LICENSE 文件~~ ✅ 已完成（v1.2.4） |
| **P1** | `CONTRIBUTING.md`：本地启动、测试命令、提交信息规范、PR 流程 |
| **P1** | `docs/adr/`：至少 3 篇 —— ① 同步协议选型（DMP vs CRDT）② 存储选型（SQLite vs Postgres）③ 权限模型（三层访问 + 写权限门控） |
| **P2** | `docs/OBSERVABILITY.md`：日志字段、`/api/health` vs `/api/health/ready` 语义、备份恢复步骤、常见故障排查 |
| **P2** | 抽 `docs/API.md`，README 只留索引 |

---

## 4. 测试覆盖率 —— 有测试，但"不知道覆盖了多少"

**现状**：95 例集成测试全过（identity / smoke / convert / security / write-access）+ 3 个 Playwright E2E spec。测试代码 4315 行 vs 源码 9642 行（比值 0.45，不算低）。**但没有任何覆盖率度量**——`package.json` 无 `c8`/`nyc`/`--experimental-test-coverage`。

**对标**：HedgeDoc 有 `codecov.yml`（覆盖率外显到 PR）；SilverBullet 同时有 `vitest.config.ts`（单元）+ `playwright.config.ts`（E2E）双轨。

**具体缺口**
1. **零单元测试**：所有测试都是"起真实子进程 + 真实 SQLite + 真实 Worker"的集成测试。前端 `public/js`（3508 行，含最复杂的 `text-sync.js` 739 行）**完全没有被测**——diff 计算、光标映射、IME 组合态、离线队列塌缩这些**纯函数逻辑最该单测、却最容易靠集成测试漏掉**。
2. **无覆盖率门禁**：无法回答"这 95 例覆盖了百分之多少分支"。
3. **前端无测试框架**：没有 vitest/jsdom，`public/js` 只能靠 Playwright 端到端覆盖，成本高、反馈慢。

**改进建议**
| 优先级 | 动作 |
|---|---|
| **P1** | 接入覆盖率：`node --import tsx --test --experimental-test-coverage tests/*.test.js`，先只**度量不上门禁**，跑出基线数字 |
| **P1** | 把 `text-sync.js` 的纯逻辑（diff 生成/应用、光标映射 `mapCaret`、队列塌缩）抽成无 DOM 依赖的模块，用 `node:test` 直接单测。**这是性价比最高的一项** |
| **P2** | 覆盖率基线稳定后，对 `src/services/**` 设 70% 门禁并写入 CI |
| **P2** | 引入 vitest 覆盖 `public/js`（可选；若坚持零前端框架，至少把纯逻辑模块抽出来用 `node:test`） |

---

## 5. 代码质量 —— 类型严格度好，但 `any` 与静默吞异常偏多

**现状（优点）**：`strict: true`；0 个 TODO/FIXME；0 个 `console.log`（日志走 pino）；ESLint + Prettier 且进入 CI；错误统一 `{ error: string }` + `logger`。

**实测技术债**
| 指标 | 数值 | 判定 |
|---|---|---|
| `: any` / `as any` / `<any>` | **142 处** | 偏多。`strict: true` 的收益被 `any` 大量抵消，尤其在 `routes/*.ts` 的 `req: any, res: any` 上——Express 请求/响应全丢类型 |
| 空 catch（`catch {}` / `catch (e) {}`） | **27 处** | 高风险。AGENTS.md 明确要求"不得静默吞补丁失败"，但仍有 27 处空捕获，违反自身规范 |
| 最长文件 | `fileService.ts` 428 · `padService.ts` 417 · `types.ts` 396 · `text-sync.js` 739 | 尚可，但 `text-sync.js` 已接近"难以单测"的量级 |
| 依赖数 | 17 运行时 | 克制，优于同类（无重型框架） |

**对标**：Memos 有 `.golangci.yaml`（linter 显式配置并可本地复现）；SilverBullet 有 `STYLE.md` + `biome.json`；HedgeDoc 用 oxlint/oxfmt 且配 `REUSE.toml` 做逐文件许可证合规。

**改进建议**
| 优先级 | 动作 |
|---|---|
| **P1** | **清空 27 处空 catch**：至少补 `logger.warn` 与上下文。这条同时是 AGENTS.md 已写明却被违反的规范，属于"自己定的规矩自己没守" |
| **P1** | 给 Express 引入类型：`req: Request, res: Response`，或至少定义 `AuthedRequest extends Request { userId?: string }`，逐步消掉 `routes/` 的 `any` |
| **P2** | ESLint 加 `@typescript-eslint/no-explicit-any` 为 `warn`（不阻塞 CI），配合存量清单逐步清零 |
| **P2** | 写 `STYLE.md`（对齐 SilverBullet），把 AGENTS.md 里面向 AI 的约定转写成面向人的规范 |

---

## 6. 功能实现 —— 核心闭环完整，但缺"留存型"能力

**已有的完整能力**（应保留并对外强调）：多 Pad 实时协作（DMP patch）、文件上传与 Office/PDF→Markdown 转换、FTS5 搜索、Pad 口令与解锁令牌、邀请码、写权限门控（`gated` 模式 + 信任成员）、Markdown 预览 + TOC、二维码、导出、主题、移动端手势、字数统计、presence。

**对标缺失（基于依赖清单与数据库表结构的实证推断）**

| 能力 | 对标项目 | 本项目证据 | 判定 |
|---|---|---|---|
| **版本历史 / 修订回放** | HedgeDoc revisions、Etherpad changeset 链 | `src/db/` 仅 `pads`/`files`/`users`/`invitations` 四张业务表，**无 revisions 表** | ❌ 缺失 |
| **插件/扩展机制** | SilverBullet `plugs/`、Etherpad `local_plugins/` | 无插件目录，转换器硬编码 | ❌ 缺失 |
| **SSO / LDAP / OIDC** | Outline、Docmost 均支持 | 依赖清单无 passport/oauth/openid 类库 | ❌ 缺失 |
| **国际化** | Docmost `crowdin.yml`、HedgeDoc 多语言 | `i18n` 相关文件仅 1 处，UI 中英混排 | ❌ 缺失 |
| **移动端原生/离线** | Memos 有移动生态 | 无 | ❌ 缺失 |
| **导出多格式（PDF/HTML）** | HedgeDoc、SilverBullet 支持 PDF | 仅 Markdown 导出（`export.js`） | ❌ 缺失 |
| **幻灯片/演示模式** | HedgeDoc slide mode | README 特性列表未见 | ❌ 缺失 |
| **附件回收站** | 竞品普遍 | 已有 TTL + 引用保护（👍 优于硬删） | ✅ 已有 |

**最大短板是「无版本历史」**：协作编辑器没有历史记录，一次误删/恶意清空即不可逆。`padService.applyPatch` 已经在写 `textVersion`，**基础数据（版本号）已具备，缺的只是落盘 patch 链或快照**——这是投入产出比极高的补缺。

**改进建议**
| 优先级 | 动作 |
|---|---|
| **P1** | **修订历史**：新增 `revisions(pad_id, version, body, created_at, author)`；每 N 个版本或每 M 分钟存快照（参考 HedgeDoc `revisions.service.ts` 的"全量 + patch 链"），UI 提供"版本时间线 + 回滚" |
| **P1** | **Pad 回收站**：删除先入 `deleted` 态，保留 N 天，防误删不可逆（当前 `deletePad` 是不可逆的） |
| **P2** | 转换器注册表化（见 §2），为插件生态留口 |
| **P2** | 导出 HTML/PDF（turndown 反向 + 打印样式即可，成本低） |
| **P2** | i18n：抽 `public/js/i18n.js` 文案表，先做中/英两档 |

---

## 7. 性能优化 —— 相对强项，但缺"防退化"机制

**已做的（实测有效，属于本项目亮点）**
- `patch-ack` 只回 `{textVersion, seq}`，广播只发 diff（对标 Etherpad `ACCEPT_COMMIT`）
- FTS 从"每击键全量重建"改为 per-pad 防抖（1200ms）+ 启动对账 + 停机 flush
- 元数据查询用 `findByIdMeta` / `findAllMeta` 避免读 100KB 正文
- 搜索 snippet 用 prepared statement 缓存
- 转换走 Worker 线程 + 堆上限 + 并发上限 + 60s 超时
- 上传 `.part` + `rename` 原子替换
- 文件 TTL 引用保护

**对标差距**
1. **无基准测试**：SilverBullet 有 `bench/` 目录。本项目所有性能结论来自代码推理，**没有可复现的量化基线**。
2. **无性能回归门禁**：CI 只跑功能测试，一次"顺手重构"把 O(1) 改成 O(n) 不会被发现。
3. **疑似未分页**：文件列表若走 `findAll` 无上限，Pad 数/文件数增长后线性劣化（**需实测确认，标注为疑似**）。
4. **DMP 的固有复杂度**：大文档下 diff 计算成本随文本长度增长；单 in-flight 保证串行但大文档编辑延迟会上升。

**改进建议**
| 优先级 | 动作 |
|---|---|
| **P1** | 建 `bench/` 并产出 3 条基线：① 单 Pad 100 并发 patch 的 p50/p95 延迟 ② 10KB 文档的 diff 计算耗时 ③ 1000 文件列表接口耗时。**先有数字再谈优化** |
| **P1** | 实测文件/Pad 列表是否无上限拉取；若是，加 `limit/offset` 游标分页 |
| **P2** | 把 bench 接入 CI 作为"性能冒烟"（超基线 2 倍即失败），防止退化 |
| **P2** | 大文档（>50KB）分块 diff 或引入长度阈值告警 |

---

## 8. 可维护性与扩展性 —— 规范意识强，机制化不足

**优点**：`AGENTS.md` 是**质量极高**的约定文件（WS 关闭码语义、patch 协议不变量、健康检查 liveness/readiness 分离、容器 `mem_limit` 陷阱、IME 约束……），比多数同量级项目更严谨。CI 4 job 覆盖 lint/test/docker/e2e 且跨 Node 18/20/22——**这点是超过 HedgeDoc/Memos 之外的多数项目的**。

**机制化缺口**
1. **规范只写在 `AGENTS.md`（面向 AI），没有面向人的 `CONTRIBUTING.md` / `STYLE.md`** → 外部贡献者无门。
2. **无依赖自动更新**（对标 Etherpad `dependabot.yml`、HedgeDoc `renovate.json`）：`npm audit` 只在 CI 里报错，不自动修。
3. **无 CODEOWNERS** → 无人对模块负责（Memos 有）。
4. **无发版自动化** → CHANGELOG 手写，版本号靠人（`package.json` 1.3.0 但 CHANGELOG 最新条目在 `[Unreleased]`，存在**版本与变更记录不同步**的隐患）。
5. **`any` 142 处** → 重构时类型系统无法保护你，改动 `routes/` 时风险高。
6. **无 ADR** → 决策不可追溯，6 个月后无法回答"当初为什么这么设计"。

**改进建议**
| 优先级 | 动作 |
|---|---|
| **P1** | 加 `.github/dependabot.yml`（每周，`grouped`），依赖漏洞自动提 PR |
| **P1** | 发版自动化 + 从 CHANGELOG 生成 GitHub Release，消除"版本号与变更记录不同步" |
| **P1** | `CONTRIBUTING.md` + `STYLE.md`（把 AGENTS.md 的人读版拆出来） |
| **P2** | `CODEOWNERS` 指定模块负责人（哪怕单人项目也预留） |
| **P2** | `docs/adr/` 沉淀关键决策 |
| **P2** | 逐步消除 `routes/` 的 `any`（配合 §5） |

---

## 9. 深层问题：并发正确性与安全模型（代码级实证）

> 前八节停留在工程治理层。以下是**代码层**问题，直接影响正确性与可用性，优先级高于多数治理缺口。
> 每条都落到具体文件行号；未经验证的标注为**待验证**。

### 9.1 并发控制是"可选"的，不是强制的 —— 省略一个字段即可绕过

`src/services/padService.ts:194`
```ts
if (baseVersion != null && pad.textVersion !== baseVersion) {
  return { ok: false, pad };   // nack，让客户端重同步
}
```
`baseVersion` 是**可选参数**（默认 `null`）。客户端只要不传，版本校验整段被跳过，patch 直接应用到当前正文，**静默覆盖并发编辑**。

HTTP 全量正文路径同样如此 —— `padService.ts:277`：
```ts
if (baseVersion != null && pad.textVersion !== baseVersion) {
  return { ok: false, conflict: true, pad };
}
```
不传 `baseVersion` ⇒ **无条件整篇覆写**，其他人的编辑直接蒸发。

AGENTS.md 已承认这点（"a patch WITHOUT baseVersion (legacy/manual clients) is still applied"）。但这等于**整个乐观并发控制是 opt-in 而非 enforced**：任何一个写错的、或恶意的客户端，靠省略一个字段就能关掉它。而你们自己的竞品分析把"每条 patch 带 baseRev，不符即 nack"列为 P0 建议 —— 最终实现成了可选。

**建议**：服务端强制要求 `baseVersion`（缺失即 nack）；若必须兼容旧客户端，至少对"无版本号 且 该 pad 近 N 秒内有其他写入者"的组合直接拒绝。

### 9.2 未设 `PUBLIC_ORIGIN` 时，CSRF 信任整个私有网段

`src/middlewares/security.ts:28-40`
```ts
function isAllowedOrigin(origin) {
  if (!origin) return true;              // ← fail-open
  if (origin === 'null') return false;
  if (EXPLICIT_PUBLIC_ORIGIN) return origin === EXPLICIT_PUBLIC_ORIGIN;
  const host = new URL(origin).hostname;
  if (isPrivateIp(host)) return true;    // 10.x / 172.16-31.x / 192.168.x / fd00::/8 / fe80::/10
  return false;
}
```
两个问题：

1. **未设 `PUBLIC_ORIGIN`（默认）时，任何私有网段来源都被信任**。本项目定位正是 LAN / 团队部署 —— **LAN 恰恰就是威胁面**：一台被控的内网设备、一个内网恶意页面，都能对状态变更接口发起 CSRF。Docker/Caddy 部署常落在 `172.x`。
2. **`!origin` 直接 `return true`（fail-open）**。HTTP 路径还有 Referer 兜底（`security.ts:61-62`）并以 403 收口；但 **WS 路径没有兜底** —— `src/ws/index.ts:93` 调用同一个函数，不带 `Origin` 的 WS 客户端直接放行。

**建议**：WS 路径改 fail-closed（无 Origin 时需显式开关才放行）；私有网段豁免收窄为可配置的 `TRUSTED_ORIGINS` 白名单。

### 9.3 `/api/auth/register` 在无 Origin 头时完全豁免校验

`src/middlewares/security.ts:59-60`
```ts
if (req.path === '/register' && req.baseUrl === '/api/auth') return next();
```
开放注册 + 该路径豁免 origin 校验 = 任意来源可批量注册账号。**待验证**：注册路由是否挂载了 rate limit；若没有，这就是账号与存储的资源滥用入口。

### 9.4 无磁盘 / 对象配额 —— 单账号可打满磁盘

| 常量 | 值 | 位置 |
|---|---|---|
| `MAX_FILE_BYTES` | 100 MB（**单个文件**） | `config.ts:30` |
| `MAX_PADS` | 50（**全局**，非 per-user） | `config.ts:34` |
| `FILE_TTL_HOURS` / 检查间隔 | 72 h / 1 h | `config.ts:35-36` |
| **聚合磁盘配额** | **无** | — |

单账号重复上传 100MB 文件，未被引用的文件最长存活 72h + 1h 检查间隔。**100 个文件 = 10GB**，小容器 / VPS 直接写满磁盘 → SQLite 写入失败 → 全站不可用。同理 `MAX_PADS=50` 是全局上限，一个用户建满 50 个 pad 就能让所有人无法新建。

**建议**：加 per-user 配额（文件数 + 总字节）与全局磁盘水位检查（超阈值拒绝上传并告警）。

### 9.5 每次击键写全量正文 —— 写放大（已知取舍，但成本未量化）

`padService.ts:223` → `store/index.ts:94` → `db.pads.updateText()`：每个 patch 落库都把**整篇正文**（上限 100k 字符）作为一个 UPDATE 写入。

AGENTS.md 明确禁止把它改成写防抖（测试用 SIGKILL 清场）—— 这是**为保障崩溃安全的合理取舍**。但代价可量化：100KB 文档 × 5 次编辑/秒 ≈ 500KB/s 写入 WAL，8 小时工作日约 **14GB WAL 写入量**。对树莓派 / SD 卡这类 LAN 部署常见载体，是切实的磨损与 checkpoint 抖动。

竞品分析把"持久化降频"列为 P0（HedgeDoc 快照式），你们 consciously 没做。**问题不在取舍本身，在于没有 `bench` 数据支撑这个取舍**（见 §7）。

**建议**：即使不改策略，也应把"崩溃窗口 vs 写放大"的实测数字写进 ADR，让后续维护者知道代价。

### 9.6 全量重同步路径会把瘦身优化打回原形

`padService.ts:283-292` —— HTTP 全量正文路径广播的是**完整正文**：
```ts
this.broadcast.toPad(padId, { type: 'text-update', padId, text: updated.text, ... })
```
diff-only 瘦身只覆盖了 `applyPatch` 的正常路径。**一旦客户端进入 nack → 全量重同步循环**（shadow 反复发散时很容易发生），每个 peer 就会重新收到整篇 100KB —— 正是 §7 里"每击键 400KB"的老问题，只是被搬到了失败路径上。

**建议**：重同步改为只发给发起方（单播），其他 peer 仍走 diff 通道；或对全量帧单独限流。

### 9.7 幂等去重表在内存，重启即失效且上限偏小

`padService.ts:183, 230-236`：`patchReceipts` 是进程内 `Map`，24h TTL，FIFO 上限 10000。
- **重启即丢失**：服务重启后客户端重试同一 `operationId` 会被重新应用（补丁语义下通常 `patch_apply` 失败自限，属低危）。
- **10000 上限偏小**：全部 pad 累计 1 万次操作（约 1 万次击键，小团队几小时即到）就触发 FIFO 淘汰，**静默关掉更早操作的去重**。

**建议**：去重表落 SQLite（小表 + 过期清理），或明确它是"尽力而为"并在文档写明失效语义。

### 9.8 一处证伪：Session 吊销机制是存在的（假设被推翻）

我原本假设"无状态 HMAC token ⇒ 无法吊销、泄露后 30 天内无法回收"。**读 `src/auth/session.ts` 后证伪**：项目有 `revokedTokens`（`src/db/revokedTokens`），吊销记录持久化到 SQLite、启动时恢复、10 分钟清理一次过期项。这条从问题清单划掉。

保留此条作为审计方法说明：**结论必须落到源码，不能靠架构推断**。

---

## 10. 优先级路线图

### P0（阻断项，必须最先做）
| # | 动作 | 理由 |
|---|---|---|
| **0** | **提交并推送本地 57 个文件的改动** | 无远端备份、无 CI 验证，单机故障即全损。风险高于本报告其余全部条目之和 |
| 1 | **补 `LICENSE`（MIT）** | 无许可证 = 法律上不可采用，是 star/fork 为 0 的硬阻断；且与 `package.json`、README 声明矛盾 |
| 2 | 补 `CONTRIBUTING.md` + ISSUE/PR 模板 | 0 issue 不是没 bug，是没有贡献路径 |

### P1（拉开与同量级项目差距）
| # | 动作 | 维度 |
|---|---|---|
| 3 | 修订历史（revisions 表 + 快照/回滚 UI） | 功能实现 |
| 4 | Pad 回收站（删除可逆） | 功能实现 |
| 5 | 接入覆盖率度量，先出基线数字 | 测试 |
| 6 | `text-sync.js` 纯逻辑抽出并单测 | 测试/可维护性 |
| 7 | 清空 27 处空 catch + 收敛 `routes/` 的 `any` | 代码质量 |
| 8 | 补 `SECURITY.md` + `package.json` 的 `repository`/`author` | 社区/文档 |
| 9 | 建 `bench/` 产出 3 条性能基线 | 性能 |
| 10 | dependabot + 发版自动化 | 可维护性 |
| 11 | `docs/adr/` 三篇核心决策 | 文档 |

### P2（长期竞争力）
| # | 动作 | 维度 |
|---|---|---|
| 12 | 转换器注册表化 → 插件机制雏形 | 扩展性 |
| 13 | i18n 文案表（中/英） | 功能实现 |
| 14 | 导出 HTML/PDF | 功能实现 |
| 15 | 覆盖率门禁（services 70%）+ 性能回归门禁 | 测试/性能 |
| 16 | `STYLE.md` + `CODEOWNERS` + API 独立文档 | 文档/治理 |

---

## 11. 相对优势（应保留并在 README 强调）

对标不是全盘否定。以下能力在同量级项目中并不常见，是当前 README 未充分表达的卖点：

1. **零框架前端 + 极轻依赖**（17 个运行时依赖，无 React/Vue）——自托管部署体积小、供应链攻击面小。
2. **工程纪律超前**：liveness/readiness 分离、WS 关闭码语义化、patch 协议不变量、容器内存限制陷阱、IME 组合态约束——这些写在 `AGENTS.md` 里的约定，很多万星项目都没显式定义。
3. **文件生命周期的引用保护**：TTL 只回收"未被正文引用"的附件，避免了竞品常见的"删附件留死链"问题。
4. **写权限门控四层模型**（访客/持令写/信任成员/管理员）+ 信任成员白名单替代永久后门口令——安全性设计优于多数同类。
5. **CI 覆盖 Node 18/20/22 三版本 + Docker 冒烟 + E2E**，比 HedgeDoc 之外的多数对标项目更完整。

---

## 附：证据来源

- GitHub REST API：`/repos/{owner}/{repo}`（星标/fork/issue/许可证/推送时间）、`/repos/{owner}/{repo}/contents/`（根目录清单）、`/repos/{owner}/{repo}/contents/.github`（治理配置）、`/repos/{owner}/{repo}/commits`（提交数与最近提交）
- 本地只读统计：`git ls-files`（追踪文件）、`wc -l`（规模）、`grep`（技术债计数）、`package.json` / `tsconfig.json` / `.github/workflows/ci.yml` 读取
- 未改动任何源码，未提交任何变更
