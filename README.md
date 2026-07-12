# 学径（Xuejing）Windows 桌面端

面向本科生的本地优先学习中枢：聚合 Blackboard、Gradescope、课程资料、作业截止时间与期末复习工作流，帮助学生少在多个平台之间切换，也能从真实课件出发梳理知识与复习进度。

当前版本：`0.3.7`。本项目是 Electron + React + TypeScript 的 Windows 桌面应用。

## 免安装测试

不需要安装。直接双击运行：

```text
release\win-unpacked\学径.exe
```

首次运行后，按需连接 Blackboard 或 Gradescope；学校统一身份认证、验证码与二次认证仍由用户在登录窗口中完成。

## 当前能力

- 同步 Blackboard 课程、内容目录、文件、外链和作业入口；保留课程原有目录结构并支持本地缓存、自动缓存与资料库迁移。
- 同步 Gradescope 的学期、课程、作业、提交入口和可见的提交/成绩状态；Blackboard 作业与 Gradescope 作业统一进入作业中心。
- 识别和管理 DDL，支持状态修正、手动完成、提交页跳转和应用运行期间的 Windows 桌面提醒；Gradescope 作业由用户在网页下载后手动导入，应用会缓存到该作业专属目录，并按用户请求解析附件文本交由 AI 匹配课程知识点、确认后带入复习。
- 解析 PDF、DOCX、PPTX、旧版 PPT 与 LaTeX；支持扫描 PDF 的本地单份/批量 OCR，以及可选的云端 AI 知识点精炼。
- 构建“资料级主题 → 课程知识点 → 来源资料”的知识库和可缩放知识图谱，支持单课程与全部课程聚合、知识点自评。
- 提供期末复习会话：系统规划或自选资料/知识点、AI 路线建议一键应用、学习进度持久化、番茄钟、课程问答和沉浸模式。
- 在复习会话内预览 PDF、DOCX 与 PPTX；旧 `.ppt` 以结构化文本与系统默认应用打开作为降级方案。
- 记录每日学习日记、情绪和基础成长数据。

## 开发与验证

```powershell
npm install
npm run dev
```

```powershell
npm test
npm run typecheck
npm run build
```

生成 Windows 安装包：

```powershell
npm run package:win
```

安装包输出到 `release/学径-<版本号>-win-x64.exe`。开发和测试数据保存在当前 Windows 用户的应用数据目录与用户自行选择的资料库中。

## 文档导航

- [产品蓝图](PRODUCT.md)：目标用户、产品边界、下一阶段路线与隐私原则。
- [开发进度](docs/PROGRESS.md)：已实现能力、已知边界与验证记录。
- [OCR 与云端 AI](docs/OCR_AND_CLOUD_AI.md)：本地 OCR、AI 精炼与数据发送范围。
- [知识条目筛选](docs/KNOWLEDGE_FILTERING.md)：本地候选主题的筛选原则。
- [知识库分层](docs/KNOWLEDGE_ARCHITECTURE.md)：资料级主题、课程知识点和知识图谱之间的关系。
