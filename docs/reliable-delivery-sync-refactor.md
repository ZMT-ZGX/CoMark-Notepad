# 可靠投递状态机重构与格式清理 — 全过程总结

> 分支：`release/v1.1.2`
> 范围：协同同步模型（每 Pad 隔离、单 in-flight、版本条件与重试去重）+ 仓库 Prettier 格式清理
> 相关提交：`e565307`（格式）`cacfc61`（重构）`e199fed`（无关 hotkeys 容错）

---

## 1. 问题来源

协同编辑的可靠投递依赖一套状态机：以 `lastSyncedText` 作为“已确认 shadow”（diff 基准），把未确认 patch 暂存在全局数组 `inflightPatches`，断线时回收到离线队列。在这套**全局 + 多个并行 patch** 模型上持续补状态，陆续暴露了 6 个可靠投递缺陷：

| 编号 | 严重度 | 现象 |
|---|---|---|
| P1 #1 | 高 | 多个未 ACK 的 patch 串文/重复。第二次发送仍基于同一个旧 shadow，如 `""→"A"` 与 `""→"AB"` 并发被服务端依次应用成 `AAB` |
| P1 #2 | 高 | 上锁 Pad 认证失败时离线队列丢失。CONNECTING 分支入队时提前推进 shadow；`ws.js` 在收到 `hello` 前清空并发送队列；unlock token 无效时回排发现 textarea===shadow 不再入队、随后清空 in-flight |
| P1 #3 | 高 | 切换 Pad 时旧 Pad 的 in-flight 丢失或串入新 Pad。切换时重置全局状态并建新连接；旧 socket 的 `onclose` 因实例检查直接返回无法重排；`inflightPatches` 没有 `padId` |
| P1 #4 | 高 | 旧 Pad 的 HTTP 响应写新 Pad。切换时 `lastTextRequestId=0` 可能与新请求重复；409 合并分支不检查陈旧性，用 `state.currentPadId`，旧 Pad 的延迟冲突响应把合并内容写入新 Pad |
| P2 #5 | 中 | 重连时旧 GET 覆盖新 WS patch。`loadPadContent` 无条件覆盖正文但保留较大版本号；若 WS v11 先到、GET v10 后到，客户端持有 v10 却标记 v11 |
| P2 #6 | 中 | 2MB 图片粘贴上限与 100k 字符服务端上限冲突。浏览器允许近 2MB 图片，base64 > ~75KB 即触发服务端 nack；原 E2E 仅用 1×1 PNG，未覆盖边界 |

核心症结：**同步状态是全局单例，无法区分不同 Pad / 不同连接，于是不得不在全局数组与多个并行 patch 上反复打补丁。**

---

## 2. 设计决策：每 Pad 一个“shadow + in-flight + target”

将模型改为**每 Pad 隔离、串行化**的状态：

```
state.padSync[padId] = {
  lastSyncedText,   // 已确认 shadow（diff 基准）
  textVersion,      // 已确认服务端版本
  inflight,         // 单个在途操作：{ kind:'ws', seq, operationId,
                    //                  patchText, sentText, baseText, baseVersion }
                    //             或 { kind:'http', sentText, requestToken } 或 null
  pendingTarget,    // 期望达到的最新本地文本（ACK 后再 diff shadow→target）
  requestToken,     // 每 Pad 单调递增、永不复位的 HTTP 请求令牌
  pendingRemoteState,// 编辑器聚焦时延迟应用的远程文本
  seenOperations    // 已处理的远端 operationId（有上限）
}
```

三条不变量：
1. **同一 shadow 上只允许一个 in-flight**；第二个 patch 在 ACK 前只更新 `pendingTarget`，不发送。
2. **本地排队不推进 shadow**；只有权威 ACK、nack、远端 patch 或全量正文才更新已确认状态。
3. **每个 Pad / 每个 WS 实例的状态互相隔离**；请求/响应贯穿原始 `padId` + 单调 `requestToken`，陈旧响应直接丢弃。

---

## 3. 逐条修复

### P1 #1 串行化 patch 与权威 ACK（text-sync.js）
新增统一驱动器 `pump(padId)`：若 `sync.inflight` 存在直接返回；否则 WS 打开时先 flush 离线队列最旧的一项作为 in-flight，再按 `shadow → target` 发送新 diff，且**只发送一个**就等 ACK。`ackInflight(seq, text, textVersion)` 只处理匹配的在途序号，使用服务端返回的权威正文推进 shadow；若 ACK 已落后于客户端收到的远端版本，则保留较新的 shadow 并重新合并本地 target。随后再次 `pump()` 把累积的新编辑发走。

### 并发补丁的版本条件与重试去重（text-sync.js + padService.ts）
- 每个 WS patch 带 `baseVersion`、`operationId` 与 `seq`。`operationId` 由 `sessionStorage` 中的浏览器会话标识、Pad ID 和序号组成，避免从相同认证状态启动的独立客户端错误共享重试 ID。
- 服务端先检查进程内存中的 `operationId` 收据表，使 ACK 丢失后的重发可幂等返回；随后校验 `baseVersion`。版本不一致时不把旧 diff 应用到新正文，而是返回 `patch-nack` 与权威正文。
- 客户端收到 nack 后以该权威版本进入条件 HTTP 写入及合并路径；HTTP 写入同样带 `baseVersion`，冲突时重新合并，避免完整正文覆盖并发编辑。
- 广播 patch 和全量正文都带权威版本；客户端记录已见 `operationId`，并把本地 target rebase 到远端正文上，避免消息重复或乱序时丢失本地输入。

### P1 #2 flush 推迟到 `hello` 之后（ws.js + text-sync.js）
- `ws.js` `onopen` 只发认证消息，**不再** `flushPatchQueue()` / `loadPadContent()`。
- `hello` 消息处理中（`state.wsId` 已确认认证成功，含上锁 Pad 的 unlock token）才开始同步：存在待发送内容时只 `flushPatchQueue()`；否则才 `loadPadContent()`，避免 GET 与本地写入竞争。
- `queueOfflineDiff()` 计算 diff 后**不推进 shadow**（旧代码会 `lastSyncedText = currentText`），因此 unlock 失败时离线队列完整保留，回排逻辑也不会因 textarea===shadow 而漏入队。

### P1 #3 每 Pad 隔离 in-flight（pads.js + ws.js）
- `switchPad()` 在切换前先 `sendTextNow(oldPadId)` + `requeueInflight(oldPadId)`，把旧 Pad 的 in-flight / 待发送折叠回其离线队列；随后只改 `state.currentPadId` 并清空编辑器，不再重置全局 `textVersion/lastSyncedText/...`（这些现在是 per-pad，新 Pad 自动获得全新 sync 条目）。
- 每个 WS 实例标记 `newWs.padId = state.currentPadId`；`onclose` 调 `requeueInflight(newWs.padId)`，旧 socket 的 `onclose` 因 `state.ws !== newWs` 实例检查提前返回，不会把旧 patch 串入新 Pad。

### P1 #4 贯穿 padId + 单调 requestToken（text-sync.js）
- `httpFallback()` 用 `++sync.requestToken`（每 Pad 单调递增、永不复位，取代原先切换时被归零的全局 `lastTextRequestId`）。
- `mergeAndResync(localText, serverText, serverVersion, padId, sync)` 显式接收并使用 `padId` 与 `sync`，不再读全局 `state.currentPadId`；HTTP 响应返回后校验仍是当前 in-flight 的 `requestToken`，陈旧响应（来自旧 Pad）直接丢弃，不再误写新 Pad。

### P2 #5 版本守卫（text-sync.js）
`applyTextState()` 增加 `if (nextVersion < sync.textVersion) return;`：版本低于当前已确认版本的整文 GET（如 WS v11 先到、GET v10 后到）不再覆盖正文，但保留更大版本号。切换 Pad 时新 Pad 的 sync 为全新条目（version 0），正常 GET 版本更高仍会应用。

### P2 #6 客户端 base64 上限（text-sync.js + E2E）
`handleImagePaste()` 在 `reader.onload` 后按 data URL 长度（`> 75000` 字符，约 56KB 原图）提前拦截并提示，避免发出服务端必 nack 的超大 patch。新增 E2E「oversized pasted image is rejected before embedding」：~60KB PNG（base64 ~80KB）被拒、正文不变、`#toast` 提示。

---

## 4. 验证结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 格式 | `npm run format:check` | 全部 Prettier 风格（见第 5 节） |
| 类型 | `npm run typecheck` | 0 错误 |
| Lint | `npm run lint` | 干净 |
| 单元/集成 | `npm test` | 74/74 |
| E2E | `npm run test:e2e` | 17/17（含并发编辑 rebase 场景、图片粘贴、超大图片拒绝） |

E2E 数据隔离在 `tests/e2e/.e2e-data-dir`，未触碰真实 `data/`。

---

## 5. 顺带解决的 format:check 失败

### 调查结论（只读）
- 命令：`prettier --check 'src/**/*.ts'`，锁定 `prettier@^3.9.4`，配置 `.prettierrc`（`printWidth:100`、tab 2、singleQuote、trailingComma es5 等）。范围仅 `src/**/*.ts`，不含 `public/` 与 `tests/`。
- 失败 17 个文件：其中 **6 个**是本次重构改动涉及的文件，**11 个**是仓库既有问题（早已以未格式化形式提交在分支上）。
- 用 `git show HEAD:` 比对证明：这 6 个改动文件的**已提交（改动前）版本本就未格式化**——即格式失败全为既有问题，本次功能改动未引入任何新格式破坏。
- **CI 强制**：`.github/workflows/ci.yml` 的 `lint` job 第 31 行跑 `format:check`，且 `docker`/`e2e` job 有 `needs:[lint,test]`，故不过会阻断合并/发布（触发于 push/PR 到 main/master）。
- **本地 hook 当时未生效**：`.git/hooks/` 仅有 `pre-commit.sample`，`simple-git-hooks` 虽在 `package.json` 声明但未写入 `.git/hooks/pre-commit`，因此本机提交不会自动格式化；且 hook 只格式化暂存文件，无法回改那 11 个已提交文件。

### 处理
1. `npx simple-git-hooks` 装回 hook（`.git/hooks/pre-commit` → `npx lint-staged`）。
2. `npx prettier --write` 仅格式化 17 个失败文件；Prettier 仅改空白、不影响语义。
3. 对 11 个文件分别取格式提交的父版本，以仓库锁定的 Prettier 和 `.prettierrc` 重新格式化，并逐字比对提交结果；全部一致，证明是纯格式变更。`git diff -w` 不作为该结论的依据，因为换行重排仍可能显示差异。
4. 完整验证一遍全绿（见第 4 节）。

### 提交组织
- **A `e565307`** `chore: apply Prettier code style to previously unformatted files` — 11 个纯格式文件，单独提交。
- **B `cacfc61`** `refactor: per-pad isolated reliable-delivery sync model` — 同步模型重构全部改动（18 文件，含 6 个重叠文件，其格式变更随功能提交一起走）。
- **C `e199fed`** `fix: tolerate CDN-loaded hotkeys failing to load` — `public/app.js` 是与本次重构无关的既有改动（CDN hotkeys 容错），单独提交，避免污染功能 diff。

> 提交时 pre-commit hook（lint-staged）实测触发：`eslint --fix` + `prettier --write` 对暂存 `src/**/*.ts` 均为 no-op，校验通过。

---

## 6. 关键文件清单

| 文件 | 改动要点 |
|---|---|
| `public/js/core.js` | 删除全局同步字段；新增 `state.padSync` 与 `getPadSync(padId)` |
| `public/js/text-sync.js` | 重写为 `pump()` 驱动的 per-pad 单 in-flight 模型；版本守卫；客户端图片上限 |
| `public/js/ws.js` | flush 推迟到 `hello` 后；每个 WS 标记 `padId`；`onclose` 按 `padId` 回排 |
| `public/js/pads.js` | `switchPad` 切换前持久化旧 Pad；移除全局重置；`loadPadContent` 贯穿 `padId` |
| `src/services/padService.ts` | WS patch 的 `operationId` 幂等去重、`baseVersion` 条件校验与权威正文广播 |
| `src/ws/index.ts` | 校验 WS 消息 Pad ID，回传含正文与版本的 ACK / nack |
| `tests/e2e/collaboration.spec.ts` | 新增超大图片粘贴边界测试 |
| `CHANGELOG.md` | 记录本次重构与测试计数（74 单测 + 17 E2E） |

---

## 7. 后续建议
- 保留已安装的 `simple-git-hooks`，新提交会自动格式化暂存的 `src/**/*.ts`，避免再次累积格式漂移。
- 离线队列基于“上次确认 shadow”计算 diff，若用户离开 Pad 期间该 Pad 有他人远程编辑、返回后 GET 到的权威正文已演进，离线 diff 可能不干净合并；这是离线队列固有限制，本次未扩大解决范围（属既有行为，非本次回归）。
- `operationId` 收据表目前仅在服务进程内存中保存；服务重启后无法识别重启前 ACK 丢失的重发。如需跨重启的严格幂等，需要将收据持久化到数据存储。
