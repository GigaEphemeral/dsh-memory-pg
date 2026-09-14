# `/memory-pg-compact` 未生效 — 问题原因与定位日志

> 记录时间：2026-09-14（晚）
> 场景：在 DSH Web GUI（`http://127.0.0.1:3099`，隔离实例 `.testhome`）输入 `/memory-pg-compact`，命令未被宿主拦截，而是作为普通文本消息转发给了 agent。

---

## 1. 现象

- 用户在聊天框输入 `/memory-pg-compact`。
- 期望：宿主识别该斜杠命令并直接执行（插件 handler 提炼会话 → 生成 md 记忆文件，不入库）。
- 实际：命令未被拦截，作为普通用户消息进入了模型侧（本 agent 收到的是命令文本本身）。

## 2. 结论（一句话）

**当前运行中的 DSH 实例（PID 2560，15:37 启动）加载的是 profile `m0test` 里 15:35 安装的「M1 旧版」插件包，其中没有 M3 里程碑注册的 `/memory-pg-*` 命令，因此宿主不认识 `/memory-pg-compact`，只好把它当普通消息转发。**

## 3. 根因链条

| # | 环节 | 状态 | 证据 |
|---|---|---|---|
| 1 | 插件源码 `src/commands.ts`（五条 `/memory-pg-*` 命令） | ✅ 已写好（M3，18:31 标记完成） | 源码含 `memory-pg-compact` / `memory-pg-compact-save` / `memory-pg-save` / `memory-pg-search` / `memory-pg-load` |
| 2 | 最新构建产物 `lib/commands.js` 等 | ✅ 已构建（18:53:59） | `lib/` 目录 12 个文件，含 commands/distill/store/segment/rerank/schema |
| 3 | 打包产物 `dsh-memory-pg-0.1.0.tgz` | ⚠️ 18:18:27 打包，**早于** D-M3-2 回退（18:40）与最新构建（18:53）；内容为回退前的 M3 中间版 | Node 解包 tgz 可见 `package/lib/commands.js` 等 |
| 4 | **profile `m0test` 已安装的 `node_modules/dsh-memory-pg`** | ❌ **15:35:33 安装的 M1 旧版**，`lib/` 下**没有** `commands.js` 等命令文件 | 目录清单见 §5.5 |
| 5 | **运行中的 DSH 实例（PID 2560）** | ❌ 15:37 启动，加载上述旧版插件 → 命令从未注册 | 日志时间戳 + 端口监听见 §5.4 |

**关键点**：tgz 文件虽在 18:18 更新过（已含命令代码），但 **node_modules 里的安装副本从未刷新**，运行进程加载的是启动时刻的旧代码。源码、构建产物、打包产物、已安装包四者不同步。

## 4. 定位过程（按执行顺序）

1. **grep 工作目录与 DSH 代码库**：`memory-pg-compact` 在 `D:\000CODE\plugintest`（空）与 `D:\dsharness\sof\deepseek-harness` 均无匹配 → 不是 DSH 内建命令。
2. **查环境变量**：`DSH_HOME = D:\000CODE\dsh-memory-pg\.testhome`、`DSH_WEB_URL = http://127.0.0.1:3099`、`DSH_SESSION_ID = session-f37839e1-...` → 当前实例是隔离测试实例，且有同名项目目录 `D:\000CODE\dsh-memory-pg`。
3. **在项目里 grep `compact`**：命中 `task.md` / `README.md` / `src/commands.ts` → 确认这是 `dsh-memory-pg` 插件 M3 里程碑注册的命令；`task.md` 第 81 行标记该命令「已注册、写入 memoryDir md」。
4. **读 `src/commands.ts` 与 `src/index.ts`**：确认命令行为（distill → 写 `memoryDir` md，不入库）与依赖注入；`memoryDir = join(process.cwd(), '.memory-pg-files')`。
5. **读 `task.md` 全文**：确认 M3 退出标准、以及「隔离实例 m0test」的启动/安装约定。
6. **检查 `.testhome` 结构**：找到 profile `m0test`、日志、会话目录、profile package.json（bundles 含 `dsh-memory-pg`，依赖 `file:...dsh-memory-pg-0.1.0.tgz`）。
7. **检查已安装插件内容（关键证据）**：`node_modules\dsh-memory-pg\lib\` 只有 M1 文件，无命令文件 → 判定为旧版。
8. **查端口与进程**：3099 由 PID 2560 监听并有活跃连接；`web-m0test.log` 最后写入 15:37:35 → 实例 15:37 启动，早于 M3 代码完成（18:31）与最新构建（18:53）。
9. **Node 解包 tgz**：确认 tgz 已含命令代码，但与已安装副本、运行进程不一致 → 定位完成。

## 5. 证据/日志

### 5.1 环境变量
```
DSH_HOME       D:\000CODE\dsh-memory-pg\.testhome
DSH_WEB_URL    http://127.0.0.1:3099
DSH_SESSION_ID session-f37839e1-bb36-47d6-8a25-b20eb943afa5
DSH_SHELL      1
```

### 5.2 profile 配置（`.testhome\profiles\m0test\package.json` 节选）
```json
"dependencies": { "dsh-memory-pg": "file:D:/000CODE/dsh-memory-pg/dsh-memory-pg/dsh-memory-pg-0.1.0.tgz" },
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-memory-pg"], "patchReload": "live" } }
```
`cordis.patch.yml` / `cordis.yml` 均为空列表（`[]`）——加载靠 bundles 机制而非 patch。

### 5.3 源码侧时间线
```
src/commands.ts 等 M3 命令代码   完成（task.md 标记 18:31:44）
docs/compaction-gap.md           18:51 之后
lib/ 最新构建产物                18:53:59（含 commands.js 7947B / distill.js / store.js / segment.js / rerank.js / schema.js）
dsh-memory-pg-0.1.0.tgz         18:18:27（含命令代码，但为 D-M3-2 回退前版本）
```

### 5.4 运行实例证据
```
端口 3099:  TCP LISTENING  PID 2560（另有 ESTABLISHED 连接，来自 PID 16352 客户端）
web-m0test.log    LastWriteTime 2026/9/14 15:37:35  Length 82
web-m0test.err.log LastWriteTime 2026/9/14 15:36:20  Length 0
会话文件 session.v3.jsonl.zstd  LastWriteTime 2026/9/14 19:36:14（活跃，实例持续写入）
```
`web-m0test.log` 全文：
```
dsh web: http://127.0.0.1:3099/?token=dWoGLMJ4__eOfzpu0J1y1HnkDsf3Rw4mLCx20NS6Mwc
```
→ 实例 15:37 启动；此时安装副本（15:35）为 M1 旧版。

### 5.5 已安装插件副本（决定性证据）
`D:\000CODE\dsh-memory-pg\.testhome\profiles\m0test\node_modules\dsh-memory-pg\`（全部文件时间 15:35:33）：
```
lib\index.js / lib\index.mjs / lib\config.js / lib\prefs.js
lib\client.js / lib\client\index.js / lib\types\...
src\config.ts / src\prefs.ts / src\index.ts / src\client\index.tsx
```
**缺失**：`lib\commands.js`、`lib\distill.js`、`lib\store.js`、`lib\segment.js`、`lib\rerank.js`、`lib\schema.js` → 无命令注册 → `/memory-pg-compact` 不被识别。

### 5.6 打包产物 tgz 内容（Node 解包）
```
package/lib/client.js, commands.js, config.js, distill.js, client/index.js,
package/lib/index.js, prefs.js, rerank.js, schema.js, segment.js, store.js, index.mjs
package/src/commands.ts, config.ts, distill.ts, index.ts, prefs.ts, rerank.ts, schema.ts, segment.ts, store.ts, client/index.tsx
package/cordis.patch.yml, package.json, README.md
```
→ tgz 本身已含命令代码；问题不在打包，而在「已安装副本未刷新 + 进程未重启」。

## 6. 修复路径（本次未执行，用户已叫停）

若要让命令生效，需依次：
1. `npm run build`（`lib/` 已有最新产物，可跳过）→ `npm pack` 重新打 tgz。
2. 重装到 profile：
   `node --import tsx/esm apps/cli/src/bin.ts plugin --profile m0test add "<新 tgz>"`（harness-root 为 `D:\dsharness\sof\deepseek-harness`）。
3. 确认挂载：`... --profile m0test --dump-config | findstr memory-pg`。
4. 重启实例：kill PID 2560 后按 `开发经验.md` 的 `Start-Process` 命令以 `DSH_HOME=.testhome`、`--profile m0test --no-open --port 3099` 重新启动。
5. 新会话中输入 `/memory-pg-compact` 端到端验证（写入目录为 `process.cwd()/.memory-pg-files`）。

## 7. 附：相关文件清单

| 路径 | 角色 |
|---|---|
| `D:\000CODE\dsh-memory-pg\dsh-memory-pg\src\commands.ts` | 命令注册源码（M3） |
| `D:\000CODE\dsh-memory-pg\dsh-memory-pg\src\index.ts` | 插件入口 / 依赖注入 / memoryDir |
| `D:\000CODE\dsh-memory-pg\dsh-memory-pg\src\distill.ts` | 提炼 prompt（含 D-M3-2 采纳的官方纪律） |
| `D:\000CODE\dsh-memory-pg\dsh-memory-pg\task.md` | 任务清单（M3 状态、退出标准） |
| `D:\000CODE\dsh-memory-pg\dsh-memory-pg\开发经验.md` | 安装/启动命令记录（§108-129 附近） |
| `D:\000CODE\dsh-memory-pg\.testhome\profiles\m0test\package.json` | profile bundles 声明 |
| `D:\000CODE\dsh-memory-pg\.testhome\profiles\m0test\node_modules\dsh-memory-pg\` | **旧版安装副本（根因）** |
| `D:\000CODE\dsh-memory-pg\.testhome\web-m0test.log` | 实例启动日志 |
| `D:\000CODE\dsh-memory-pg\dsh-memory-pg\dsh-memory-pg-0.1.0.tgz` | 打包产物（含命令代码，但未重装） |
