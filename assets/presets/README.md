# 预置人偶模型（preset GLB）

生成失败或人偶没有真实模型时，服务端会自动从这里取第一个 `*.glb` 作为兜底
（`applyFallbackModel`，见 `src/server/services/generation.ts`），并把
`gen_tasks.fallback_used` 置 1、`stage=fallback`。

- 命名：`preset-01.glb`、`preset-02.glb` …（按文件名字典序取第一个可用模型）
- 要求：与生成链路同样的上限（≤ 8MiB、≤ 30 万三角面），面数与体积越小越好
  （现场只做 1 个真实生成，其余都用预置）
- 建议：6 个统一风格的低面数人偶，高度归一化到 ~0.35m、脚底在原点，
  由 `scripts/blender/clean.py` 处理后再放进来
- 没有预置 GLB 时，3D 展柜会继续显示程序化占位人偶，功能不受影响

> 这些文件会随仓库分发，请确认素材授权（自建或可商用）。
