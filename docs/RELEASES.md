# 版本与发布管理

## 当前版本

- 源码版本：`1.0.0`
- 当前免安装构建：`release/win-unpacked/学径.exe`
- 当前安装包：`release/学径-1.0.0-win-x64.exe`
- 版本号需要同时更新 `package.json`、`package-lock.json`、`electron/preload.cjs`、`README.md`、`PRODUCT.md` 和 `docs/PROGRESS.md`。

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

构建完成后，免安装版位于 `release/win-unpacked/`，安装包位于 `release/`。

## GitHub 发布

- 普通提交和 Pull Request 会运行 `.github/workflows/ci.yml`。
- 推送形如 `v1.0.0` 的标签后，`.github/workflows/release.yml` 会在 Windows 环境重新测试、打包并创建 GitHub Release。
- Git 仓库只保存源码、测试和文档；历史 `.exe`、解压目录、`node_modules` 和 `dist` 不上传。
