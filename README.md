# 学径 Xuejing

[![CI](https://github.com/sz-wz/xuejing-study-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/sz-wz/xuejing-study-hub/actions/workflows/ci.yml)
[![最新版本](https://img.shields.io/github/v/release/sz-wz/xuejing-study-hub?display_name=tag&sort=semver)](https://github.com/sz-wz/xuejing-study-hub/releases)
[![代码仓库](https://img.shields.io/github/stars/sz-wz/xuejing-study-hub?style=flat)](https://github.com/sz-wz/xuejing-study-hub)

面向本科生的本地优先学习中枢。学径把 Blackboard、Gradescope、课程资料、作业截止时间和复习计划放进一个 Windows 桌面应用，让学生从“到处找信息”回到“知道下一步学什么”。

这是一个完整的 Electron + React + TypeScript 产品项目，当前版本为 `1.2.1`。

## 产品展示

![学习总览](submission/competition-2026/media/screenshots/01-overview.png)

| 学习收件箱 | 资料库 | 作业中心 |
| --- | --- | --- |
| ![学习收件箱](submission/competition-2026/media/screenshots/02-inbox.png) | ![资料库](submission/competition-2026/media/screenshots/03-library.png) | ![作业中心](submission/competition-2026/media/screenshots/04-assignments.png) |

| 知识库 | 复习工作区 | 学习日历 |
| --- | --- | --- |
| ![知识库](submission/competition-2026/media/screenshots/05-knowledge.png) | ![复习工作区](submission/competition-2026/media/screenshots/07-review.png) | ![学习日历](submission/competition-2026/media/screenshots/09b-learning-calendar.png) |

## 作品集重点

### 我解决的问题

大学生的课程信息分散在学校平台、作业平台、邮箱和本地文件夹里。学径将同步、整理、阅读、复习和提醒串成一条本地优先的学习工作流，并保留原始资料与来源。

### 已完成的能力

- 聚合 Blackboard 课程、内容目录、文件、外链和作业入口，支持缓存、资料库迁移和重复同步去重。
- 聚合 Gradescope 学期、课程、作业、提交入口和可见成绩状态，统一进入作业中心。
- 学习收件箱集中呈现新课程、新资料、新作业、DDL、提交状态和成绩变化。
- 解析 PDF、DOCX、PPTX、旧版 PPT 和 LaTeX，支持扫描 PDF 的本地 OCR。
- 将课程资料整理为主题、知识点和来源资料，支持知识地图、检索、自评与复习。
- 提供复习队列、间隔复习日程、番茄钟、学习日历、成长记录和成就反馈。
- 可选 SMTP 通知、后台同步和 AI 辅助分析；密钥与邮箱凭据使用 Windows 安全存储。

### 工程亮点

- Electron 主进程与 React 渲染层分离，通过 preload 建立受控 IPC 边界。
- 本地数据优先：课程资料、知识库和学习记录可离线使用，外部平台只在同步时访问。
- 对同步、缓存、版本选择、复习队列、知识地图和文档解析编写了单元测试与 Node 检查。
- GitHub Actions 自动执行测试、类型检查和构建；推送版本标签后自动生成 Windows 安装包与免安装包。

## 技术栈

`Electron` · `React` · `TypeScript` · `Vite` · `Vitest` · `Node.js`

核心目录：

```text
src/       React 界面、学习工作流和可测试的前端领域逻辑
electron/  主进程、IPC、平台集成、同步、OCR 和本地数据能力
docs/      产品设计、架构、进度和发布记录
submission/competition-2026/  产品截图、演示材料和参赛资料
```

## 从 GitHub 获取

项目地址：<https://github.com/sz-wz/xuejing-study-hub>

Windows 安装包和免安装包发布在 [GitHub Releases](https://github.com/sz-wz/xuejing-study-hub/releases)。下载后可以直接运行免安装版中的 `学径.exe`。

如果只想查看源码、设计和实现过程，直接浏览本仓库即可；项目没有把 `node_modules`、临时文件和历史构建目录提交到 Git。

## 本地运行

环境要求：Windows、Node.js 22+

```powershell
git clone https://github.com/sz-wz/xuejing-study-hub.git
cd xuejing-study-hub
npm ci
npm run dev
```

验证项目：

```powershell
npm test
npm run typecheck
npm run build
```

生成 Windows 安装包：

```powershell
npm run package:win
```

构建结果位于 `release/`。首次使用 Blackboard、Gradescope 或 AI 服务时，需要在应用内完成自己的登录和配置；项目不会把账号密码提交到仓库。

## 项目文档

- [产品说明](PRODUCT.md)：目标用户、产品边界和设计方向
- [开发进度](docs/PROGRESS.md)：已实现能力与验证记录
- [知识库架构](docs/KNOWLEDGE_ARCHITECTURE.md)：资料、主题、知识点和来源之间的关系
- [OCR 与云端 AI](docs/OCR_AND_CLOUD_AI.md)：本地解析、OCR 与可选的 AI 流程
- [发布记录](docs/RELEASES.md)：版本、构建和 GitHub Release 约定

## 许可

本仓库目前用于个人作品展示与项目开发。代码和素材的授权范围以仓库后续发布的许可证文件为准。
