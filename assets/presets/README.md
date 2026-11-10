# 预置人偶模型（preset GLB）

生成失败或人偶没有真实模型时，服务端会自动取这里字典序第一个 `*.glb` 作为兜底
（`applyFallbackModel`，见 `src/server/services/generation.ts`），并把
`gen_tasks.fallback_used` 置 1、`stage=fallback`。

## 当前资产

| 文件 | 面数 | 体积 | 说明 |
|---|---|---|---|
| `preset-01.glb` | 2796 | ~200KB | 暖黄 + 围巾 |
| `preset-02.glb` | 2826 | ~200KB | 薄荷绿 + 尖帽 |
| `preset-03.glb` | 2804 | ~200KB | 珊瑚粉 + 耳朵 |
| `preset-04.glb` | 2744 | ~200KB | 天蓝、瘦高 |
| `preset-05.glb` | 2796 | ~200KB | 金色 + 围巾 |
| `preset-06.glb` | 2744 | ~200KB | 淡紫、矮宽圆头 |

全部无贴图、单 mesh、脚底在原点、高度 0.35m，由 Blender 5.2 headless 生成。

## 重新生成

```bash
BLENDER=/Applications/Blender.app/Contents/MacOS/Blender

# 1) 生成 6 个基础角色（原始 GLB 到 /tmp/wtm-presets）
$BLENDER -b --factory-startup --python scripts/blender/make-presets.py -- --out /tmp/wtm-presets

# 2) 清理/减面/归一化 + 生成剪影
for i in 1 2 3 4 5 6; do
  $BLENDER -b --factory-startup --python scripts/blender/clean.py -- \
    --input /tmp/wtm-presets/raw-$i.glb \
    --output /tmp/wtm-presets/clean-$i.glb \
    --silhouette /tmp/wtm-presets/sil-$i.png \
    --max-tris 6000
done

# 3) 复制进仓库并跑测试
for i in 1 2 3 4 5 6; do cp /tmp/wtm-presets/clean-$i.glb assets/presets/preset-0$i.glb; done
npx vitest run tests/unit/presets.test.ts
```

> 这些文件会随仓库分发，请确认素材授权（当前 6 套为项目内程序化生成，无第三方素材）。
