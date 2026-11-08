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
- 代码：**S0 完成**——T101 仓库/构建、T102 配置与脱敏日志、T103 SQLite schema/迁移/备份；最小服务与 `/api/health` 已跑通。
- 已验证：`typecheck`、`lint`、`test`（8 个用例）、`build`、`start`、`dev`（含 Vite 代理）。
- 下一步：T104 数据访问层 → T201/T202 主人 PIN 与房间创建 → T301/T302 token/短码/二维码。

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
