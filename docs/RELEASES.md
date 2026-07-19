# 版本与发布管理

## 当前版本

- 源码版本：`1.2.1`
- 当前免安装构建：`release/win-unpacked/学径.exe`
- 当前安装包：`release/Xuejing-1.2.1-win-x64.exe`
- 当前安装包 SHA-256：`95A61D2B4067D5F20CB65E17CD548F4FFE8D74AFB8CDFB13383F026CB0AF5AC3`
- 当前免安装归档：`release/Xuejing-1.2.1-win-x64-portable.zip`
- 当前免安装归档 SHA-256：`C41EB291BD2252E302D53D69DD2A60634E40412D3B007477E0CA7DDF0F2E12AC`
- 版本号需要同时更新 `package.json`、`package-lock.json`、`electron/preload.cjs`、`README.md`、`PRODUCT.md` 和 `docs/PROGRESS.md`。

## v1.2.1 品牌统一补丁

- 托盘、侧栏品牌标识和启动动画统一使用 `image-1.png`。
- v1.2.0 参赛材料仍作为已冻结提交包保留；v1.2.1 不修改参赛内容结构。

## v1.2.0 参赛增强版

- 冻结日期：2026-07-19。
- 新增成长图鉴、月度学习日历、三级庆祝、统一品牌图标与单实例保护。
- 参赛说明、演示脚本、旁白 PPTX 和 1920×1080 演示视频同步更新。
- 当前安装包与免安装版已从同一份 `1.2.0` 源码构建，并完成启动、单实例和版本验证。

## v1.1.0 参赛冻结版

- 冻结日期：2026-07-19。
- 参赛资料位于 `submission/competition-2026/`。
- 当前安装包与免安装版均从同一份 `1.1.0` 源码构建并完成启动验证。
- 旧安装包已归档到 `artifacts/installers/legacy/pre-v1.1.0/`，不再作为当前测试入口。

## 目录约定

- `src/`：React 界面与前端业务逻辑。
- `electron/`：Electron 主进程、本地资料库、平台同步、OCR 与文件解析。
- `docs/`：产品、知识库、OCR、进度和发布文档。
- `release/`：当前本地构建产物，由 `npm run package:win` 生成，不提交 Git。
- `artifacts/releases/legacy-portable/`：历史免安装目录的本地归档，不提交 Git。
- `artifacts/installers/legacy/`：历史安装包和 blockmap 的本地归档，不提交 Git。

`release-current` 已确认是过期的 `0.2.0` 构建，因此已归入历史目录，不再作为当前版本入口。

## 本地发布步骤

```powershell
npm ci
npm test
npm run typecheck
npm run build
npm run package:win
```

构建完成后，免安装版位于 `release/win-unpacked/`，安装包位于 `release/`。发布工作流还会将免安装目录压缩为 `Xuejing-<版本>-win-x64-portable.zip`，与安装包一同上传。

## GitHub 发布

- 普通提交和 Pull Request 会运行 `.github/workflows/ci.yml`。
- 推送形如 `v1.2.0` 的标签后，`.github/workflows/release.yml` 会在 Windows 环境重新测试、打包并创建 GitHub Release。
- Git 仓库只保存源码、测试和文档；历史 `.exe`、解压目录、`node_modules` 和 `dist` 不上传。
