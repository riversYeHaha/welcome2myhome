# 欢迎来到我的家

> 在家里跑起来的「二维码寻宝 + 双层彩蛋 + 3D 收藏」游戏。
> 主人把照片生成的 3D 人偶做成实体卡藏在家中；客人连 WiFi 扫码，**立刻拆开一个彩蛋**见到人偶；有余力再答题，拆开第二层秘密。

## 文档索引

| 文档 | 说明 | 状态 |
|---|---|---|
| [项目进度与交接（2026-11-08）](docs/项目进度与交接-2026-11-08.md) | **上下文清空后先读**：已完成/未完成、已知问题、恢复步骤、当前数据状态 | 活文档（2026-11-09 更新） |
| [PRD v3（彩蛋版）](docs/prd/欢迎来到我的家-PRD-v3-彩蛋版.md) | 权威产品文档：玩法、双层彩蛋、关卡系统、终局、数据模型、API、验收清单 | 已归档（2026-11-07） |
| [技术方案 v1](docs/技术方案-欢迎来到我的家-v1.md) | 架构、技术选型、前端/服务端、E1/E2 特效引擎、3D 资产管线、数据库、API、安全、测试、部署 | 已评审修订（2026-11-08） |
| [开发计划 v1](docs/开发计划-欢迎来到我的家-v1.md) | 8 天排期、阶段 S0–S7、角色分工、55 项 WBS、每日计划、质量门、砍刀线、交付物 | 已评审修订（2026-11-08） |

## 本地开发

要求 Node 22（见 `.nvmrc`）。

```bash
npm ci
npm run dev        # API :8080 + Vite :5173（/api 已代理到 8080）
npm run verify     # typecheck + lint + test（177 tests）
npm run build      # 构建 dist/web 与 dist/server
npm start          # 生产形态：Fastify 托管 API 与 dist/web
npm run test:e2e   # Playwright 手机视口全链路（复用本机 Chrome；CI 用 test:e2e:install 装 Chromium）
```

- 首次启动会自动创建 `data/`、`data/home.db` 并执行 schema v1 迁移。
- 配置：`config/default.json`，可加 `config/local.json` 覆盖；环境变量支持 `PORT`、`HOST`、`LOG_LEVEL`、`LUX3D_ENDPOINT`、`LUX3D_API_KEY`、`BLENDER_ENABLED`、`BLENDER_PATH`。
- 可选：`{"effects":{"autoQuiz":true}}` 让 E1 结束后自动弹出彩蛋题（默认关闭，保留「再听听」按钮）。
- 服务端 PDF 用本机 Chrome/Chromium 渲染（自动探测；可用 `CHROME_PATH` 指定），没有 Chrome 时自动回退浏览器打印。
- 健康检查：`GET /api/health`（返回服务版本与 DB schema 版本）。
- 页面：客人端 `/`，主人端 `/host/`（PIN 登录后配置、看板、自检、备份）。

## 当前状态

- **测试**：`npm run verify` → **177 tests / 35 files** 全绿；`npm run test:e2e` → **4 条 Playwright 用例**（手机视口，含短码进入、PDF 下载与无 JS 兜底）。
- **已完成（P0 主链）**：
  - 基础/数据：T101–T104（TypeScript + Vite 双入口、Fastify、zod 配置、pino 脱敏、SQLite schema v1/迁移/备份、仓储层）。
  - 主人端：T201–T203 + T901–T904/T906（PIN scrypt、HttpOnly 会话、CSRF、localOnly、登录限流、房间状态机、人偶/关卡/彩蛋题/终局编辑、预览、卡片打印）。
  - 卡片与 E1：T301–T303、T401–T404、T501–T506（token/短码/二维码、SSR 卡片页、join/resume、discover、翻牌/粒子四主题/WebAudio/降级/重播）。
  - 卡片物料：T1001 A4 4-up 打印页 + **服务端 A4 PDF**（headless Chrome 渲染，二维码内联、与打印样式一致；无 Chrome 时回退浏览器打印）。
  - 客人端入口：`GET /` 按会话直达 join / collection（欢迎码扫进来不再看到骨架页）、`/join` 支持卡片 6 位短码（FR-23）、E1 后答对换第二形态 3D 模型、人偶点触轻跳 + 预设气泡台词；`effects.autoQuiz` 可选自动弹题。
  - E2/终局/收藏：T701–T705、T801–T802、T603（判题、answer/egg start·skip、secret ticket、防爆破、四种终局触发、收藏册与终局页）。
  - 3D 与生成：T601、T1201–T1205（three.js 展柜 + 程序化占位、照片上传 sharp 处理、手动 GLB、Lux3D 图生 3D、GLB 结构校验、Draco 解码、Blender headless 清理/剪影、**串行生成队列 + 重启恢复**、**第二形态 GLB 上传**、**6 套预置人偶兜底**）。
  - 看板与埋点：T1101–T1103（SSE + 5s 轮询兜底、在线客人、逐卡进度、错误统计、最近动态、JSONL 导出；`events` 表 + 浏览器 telemetry 上报）。
  - 运维：FR-01 自检（LAN IP/端口/配置完整性/模型缺失/磁盘可写/AP 隔离提示）、FR-13 备份（SQLite 快照 ×5 + 配置 JSON）与一键清空、FR-12 应急解锁（标记已发现 / 直接开彩蛋）。
  - 分享卡：T803（1080×1440 PNG，已收集名字 + 未收集虚线位）。
  - 安全：FR-47/FR-48（CSP、XFO、COOP、Permissions-Policy、按需 HSTS、CORS 白名单、join/shortcode/卡片按 IP 限流、日志脱敏、X-Request-Id）。
- **接口补充**：`GET /api/board/:room_id`、`GET /api/board/:room_id/stream`(SSE)、`POST /api/play/telemetry`、`GET /api/host/logs/export`、`GET /api/host/selfcheck`、`GET /api/host/backup/db|config`、`DELETE /api/room/:id/data`、`POST /api/room/:id/guests/:guestId/unlock`、`GET /api/share/card.png`、`GET /api/cards/pdf`、`POST|DELETE /api/dolls/:id/secret-asset`。
- **3D/生成现状**：`/viewer.js` 639KB（gzip 161KB），Draco 解码器自托管在 `/draco/`（离线可用），E2 第二形态模型复用同一场景切换；Blender 默认关闭，需 `BLENDER_ENABLED=true` + `BLENDER_PATH=...`；`assets/presets/` 已有 6 套低面数预置人偶（约 200KB / 2800 面），生成失败自动复制兜底；生成任务串行执行、重启后自动重新入队。
- **尚未接**：真实 `LUX3D_API_KEY` 端到端联调（队列已就绪）、真实打印机验收、iOS/Android/微信真机矩阵、多人关卡（race/coop/duo_scan/timed）、离线对话树/LLM 对话/记忆/TTS。
- **网络**：二维码地址优先取房间 `lan_ip`，为空时自动探测物理网卡私网 IPv4（启动/初始化时写回），不再回退到 `127.0.0.1`；可在主人端手动覆盖。
- **验收截图**：[E1 卡片](docs/screenshots/e1-card.png)、[终局](docs/screenshots/finale.png)、[现场看板](docs/screenshots/board.png)、[分享卡](docs/screenshots/share-card.png)。
- **下一步**：真实 Lux3D key 联调 → 真机网络矩阵 → 真实打印/PDF 验收 → P1（提示计数、合影、离线对话树/TTS）。

## 目录结构

```
wellcome-to-myhome/
├─ config/           # default.json（+ 本地 local.json，gitignore）
├─ docs/             # PRD、技术方案、开发计划、交接快照、验收截图
├─ scripts/          # blender/clean.py（清理+剪影）、copy-draco.mjs（解码器发布）
├─ src/
│  ├─ server/        # Fastify、配置、日志、SQLite、路由、服务（看板/生成/分享卡/运维）
│  ├─ web/           # 客人端（原生 TS）/ 主人端（React）/ 双入口 HTML / public（draco）
│  └─ shared/        # 前后端共享类型与枚举
├─ tests/            # unit / integration / e2e（Playwright）
├─ assets/presets/   # 预置人偶 GLB（兜底；见目录内 README）
└─ data/             # 运行时数据：SQLite、照片、模型、日志、备份（gitignore）
```

## 一分钟读懂

- **内核**：找到你就见到 TA，懂 TA 才听见 TA 的故事。
- **硬约束**：纯 HTTP 局域网、游戏页零摄像头、前端 100% 渲染、无第三方 CDN、单进程 `npm start`。
- **技术栈**：Node 22 + Fastify + SQLite（better-sqlite3）+ Vite + TypeScript；客人端原生 TS + three.js + Canvas 2D + WebAudio；主人端 React 18；卡片 PDF 用 pdfkit。
- **核心机制**：E1 扫码即爆特效并给人偶（零门槛、不可阻塞）；E2 答对主人家自设题才给隐藏内容（服务端判题 + 两级 ticket）。
- **3D 管线**：照片 → Lux3D 图生 3D → Blender 清理/剪影 → Draco → GLB <2MB；生成失败全部走预置人偶兜底。

## 关键数字

| 项 | 目标 |
|---|---|
| E1 特效起播 | < 300ms（脚本执行起） |
| 首屏 / 主模型 | < 2s / < 3s |
| 单 GLB | < 2MB、< 1.5 万三角面 |
| 并发 | ≥ 8 台不串号 |
| 工期 | 8 天 / 3 人（另 4 天缓冲） |
| 零卡关 | 100% 客人不答题也能见到人偶并收藏 |
