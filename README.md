# AIRI（体积优化版）

> 基于 [moeru-ai/airi](https://github.com/moeru-ai/airi) 的无损体积优化镜像 —— **566.7 MB → 366.2 MB（-35%）**，功能零删减。

## 优化内容

- **文档资源去重**：131 个跨语言目录下的重复资源（SHA256 逐字节相同）去重，引用统一指向规范路径
- **文档引用修复**：修复 123 处损坏的资源引用，校验全部 746 处 Markdown 资源引用
- **字体无损重打包**：TTF/OTF → WOFF2（62 MB → 31 MB），字形轮廓、度量、cmap 逐表校验一致
- **视频保持上游原版**：未做任何压缩，与上游逐字节一致

所有优化均为无损处理，不删减任何功能。

## 与上游的关系

本项目是上游仓库某次快照的优化版本，非持续同步的 fork。最新功能与修复请访问上游：

- 上游仓库：https://github.com/moeru-ai/airi
- 官方文档：https://airi.moeru.ai/docs/

## 本地运行

```bash
pnpm install

# 网页版
pnpm -F @proj-airi/stage-web dev

# 桌面版（Electron）
pnpm -F @proj-airi/stage-tamagotchi dev
```

## 许可证

与上游一致，采用 [MIT License](LICENSE)。版权归原作者所有，详见上游仓库。
