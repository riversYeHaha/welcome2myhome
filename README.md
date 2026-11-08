# 欢迎来到我的家

> 在家里跑起来的「二维码寻宝 + 双层彩蛋 + 3D 收藏」游戏。
> 主人把照片生成的 3D 人偶做成实体卡藏在家中；客人连 WiFi 扫码，**立刻拆开一个彩蛋**见到人偶；有余力再答题，拆开第二层秘密。

## 文档索引

| 文档 | 说明 | 状态 |
|---|---|---|
| [PRD v3（彩蛋版）](docs/prd/欢迎来到我的家-PRD-v3-彩蛋版.md) | 权威产品文档：玩法、双层彩蛋、关卡系统、终局、数据模型、API、验收清单 | 已归档（2026-11-07） |
| [技术方案 v1](docs/技术方案-欢迎来到我的家-v1.md) | 架构、技术选型、前端/服务端、E1/E2 特效引擎、3D 资产管线、数据库、API、安全、测试、部署 | 已评审修订（2026-11-08） |
| [开发计划 v1](docs/开发计划-欢迎来到我的家-v1.md) | 8 天排期、阶段 S0–S7、角色分工、55 项 WBS、每日计划、质量门、砍刀线、交付物 | 已评审修订（2026-11-08） |

## 本地开发

要求 Node 22（见 `.nvmrc`）。

```bash
npm ci
npm run dev        # API :8080 + Vite :5173（/api 已代理到 8080）
npm run verify     # typecheck + lint + test
npm run build      # 构建 dist/web 与 dist/server
npm start          # 生产形态：Fastify 托管 API 与 dist/web
```

- 首次启动会自动创建 `data/`、`data/home.db` 并执行 schema v1 迁移。
- 配置：`config/default.json`，可加 `config/local.json` 覆盖；环境变量支持 `PORT`、`HOST`、`LOG_LEVEL`、`LUX3D_ENDPOINT`、`LUX3D_API_KEY`、`BLENDER_PATH`。
- 健康检查：`GET /api/health`（返回服务版本与 DB schema 版本）。
- 页面：客人端 `/`，主人端 `/host/`（S0 占位，登录与配置在 T201/T901 接入）。

## 当前状态

- 文档：PRD 已定稿，技术方案与开发计划已按独立评审意见修订。
- 代码：S0（T101–T103）、**T104 数据访问层**、**T201–T203 主人 PIN / 会话 / CSRF / localOnly / 房间状态机**、**T301–T303 卡片 token / 短码 / 二维码 / 短码解析**、**T401–T404 E1 响应 / SSR 卡片页 / join / discover**、**T701–T705 判题 / answer / egg start·skip / secret ticket / 故障兜底**、**T801/T802 终局触发与 API**、**T901–T904/T906 主人端控制台**、**T501–T506 E1 特效引擎**、**T603 收藏册与终局页**、**T703/T704 E2 答题 UI 与 secret 接口**、**T1001 卡片打印页**、**T601 3D 人偶展柜**、**T1201/T1202/T1205 照片上传与手动 GLB 生成链路**、**T1203 Lux3D 图生 3D 接入** 已完成。
- 主人端：`/host/` 控制台（PIN 初始化/登录、开局/暂停/结束、LAN 地址、欢迎码、人偶增删改、关卡与彩蛋题编辑、终局编辑、预览、卡片打印）；API：`/api/host/status|setup|login|logout|me|pin`、`/api/room/:id`、`PATCH /api/room/:id/status|network|finale`、`POST /api/room/:id/finale/open`、`POST|PATCH|DELETE /api/dolls`、`PATCH /api/dolls/:id/level`、`POST /api/dolls/:id/backup-token`、`GET /api/cards/print`（A4 4-up，浏览器打印/另存 PDF）。
- 客人端 API：`POST /api/guests/join|resume`、`GET /api/play/d/:token`、`POST /api/play/discover`、`POST /api/play/egg/start|skip`、`POST /api/play/answer`、`GET /api/play/secret/:dollId`、`GET /api/collection`、`GET /api/finale/:room_id`、`POST /api/play/shortcode`、`GET /api/assets/:doll/:kind?t=<ticket>`、`GET /api/cards/:dollId/qr.png`、`GET /api/cards/welcome.png`；SSR：`/join`、`/d/:token`（含无 JS 收藏表单与 E2 答题面板）、`/collection`、`/finale`。
- 已验证：`typecheck`、`lint`、`test`（81 个用例）、`build`、`start`、`dev`；生产形态完成「setup → 开局 → join → SSR 卡片 → E1 → E2 答题/secret → 收藏册 / 终局 / 卡片打印页」与 `/host/` 控制台冒烟。
- 前端演出：`/effect.js` 约 11KB，覆盖 E1 时间轴/粒子/音效/降级与 E2 答题面板/金色收拢；真实设备视效与性能仍需 D3/D7 真机验收。
- 卡片：A4 4-up 打印页（欢迎码 + 每卡二维码/短码/线索），浏览器打印或另存 PDF；服务端 PDF 生成留待后续。
- 网络：二维码地址优先取房间 `lan_ip`，为空时自动探测物理网卡私网 IPv4（启动/初始化时写回），不再回退到 127.0.0.1；可在主人端手动覆盖。
- 3D：`/viewer.js`（three.js，631KB / gzip 159KB）在卡片剪影与收藏册全屏查看中加载 GLB；暂无模型时显示程序化占位人偶，支持拖拽旋转/滚轮缩放，加载失败回退剪影。
- 生成：上传照片（≤10MB）→ sharp 旋转/缩到 1536/剥离 EXIF → 生成任务。
  - `provider=manual`（默认）：停在 `awaiting_upload`，主人上传 GLB 后落盘并在 3D 展柜使用。
  - `provider=lux3d`：AHOLO Asset OUS 上传照片 → `POST /lux3d/v1/generate/img-to-3d/task/create`（G1/G1-Turbo、faceCount、enablePbr）→ 轮询 `task/get` → 下载 GLB 落盘；需设置 `LUX3D_API_KEY`，端点默认 `https://api.aholo3d.cn`。
  - 若 `provider=lux3d` 但未配置 key，会明确回退为手动上传任务。
- 尚未接：Blender headless 清理/剪影、Draco 压缩、生成任务重启恢复。
- 下一步：Blender/Draco → 服务端 PDF / 真机验收。

## 目录结构

```
wellcome-to-myhome/
├─ config/           # default.json（+ 本地 local.json，gitignore）
├─ docs/             # PRD、技术方案、开发计划
├─ src/
│  ├─ server/        # Fastify、配置、日志、SQLite、路由
│  ├─ web/           # 客人端（原生 TS）/ 主人端（React）/ 双入口 HTML
│  └─ shared/        # 前后端共享类型与枚举
├─ tests/            # unit / integration
├─ assets/           # 预置人偶、剪影、字体（T1201 接入）
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
