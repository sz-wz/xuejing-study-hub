const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

test('页面进入动画结束后不保留 transform containing block', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')
  const rule = css.match(/html\[data-motion='full'\] \.content-scroll > section \{([^}]+)\}/)?.[1] ?? ''
  assert.match(rule, /animation:\s*page-enter/)
  assert.doesNotMatch(rule, /\bboth\b|forwards/)
})

test('批量精炼开始后选择窗口会关闭，后台任务面板不使用全屏遮罩', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8')
  const runner = source.match(/const runBatchCloudRefinement = async \(\) => \{[\s\S]+?\n  \}/)?.[0] ?? ''
  assert.match(runner, /startRefinementJob/)
  assert.match(runner, /setShowBatchRefinement\(false\)/)
  assert.match(source, /\{showRefinementTaskPanel && latestRefinementJob \? <aside className="refinement-task-panel"/)
  assert.doesNotMatch(source, /\{showRefinementTaskPanel[^\n]+modal-backdrop/)
})

test('PDF 使用离屏画布并等待旧渲染任务结束后再更新可见画面', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'document-viewer.tsx'), 'utf8')
  assert.match(source, /createElement\('canvas'\)/)
  assert.match(source, /previous\?\.cancel/)
  assert.match(source, /settled\.then/)
  assert.match(source, /context\.drawImage\(offscreen/)
})

test('资料级知识点将文件标题与操作状态分成上下两行', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8')
  const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')
  assert.match(source, /knowledge-document-heading/)
  assert.match(source, /knowledge-document-actions/)
  assert.match(styles, /\.knowledge-document-actions\s*\{[^}]*flex-wrap:\s*wrap/s)
})

test('知识库只暴露本地构建与自适应 AI 精炼，并保留页码人工校正入口', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8')
  assert.match(source, /本地构建 \/ 更新/)
  assert.match(source, /批量 AI 精炼/)
  assert.doesNotMatch(source, /批量补全页级索引/)
  assert.doesNotMatch(source, /选择资料与精炼模式/)
  assert.match(source, /页面分析 \{originalAi\.coverage\.percent\}%/)
  assert.match(source, /分页兼容/)
  assert.match(source, /旧版 AI 结果/)
  assert.match(source, /知识定位 \{locatedCount\}\/\{indexedConcepts\.length\}/)
  assert.match(source, /候选页 \{candidateCount\} 项/)
  assert.match(source, /人工校正页级索引/)
  assert.match(source, /updatePageLocation\('confirm', location\)/)
  assert.match(source, /updatePageLocation\('reject', location\)/)
  assert.match(source, /updatePageLocation\('remove', location\)/)
  assert.match(source, /updatePageLocation\('add'\)/)
})

test('AI 设置提供官方服务预设、模型列表与能力检测', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8')
  assert.match(source, /AI 服务<select/)
  assert.match(source, /获取模型/)
  assert.match(source, /检测连接与能力/)
  assert.match(source, /原件直传/)
  assert.match(source, /本地分页兼容/)
})

test('启动自动同步会等待平台状态恢复完成', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8')
  assert.match(source, /if \(!platformStatusReady\)/)
  assert.match(source, /Promise\.allSettled\(\[bridge\.blackboard\.status\(\), bridge\.gradescope\.status\(\)\]\)/)
})

test('课程资料与知识库操作栏在窄内容区保持横向文字并安全换行', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8')
  const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')
  assert.match(source, /page-heading action-heading/)
  assert.match(styles, /\.library-actions[^}]*flex-wrap:\s*wrap/s)
  assert.match(styles, /\.knowledge-actions[^}]*flex-wrap:\s*wrap/s)
  assert.match(styles, /\.library-actions\s*>\s*button[^}]*white-space:\s*nowrap/s)
  assert.match(styles, /\.knowledge-actions\s*>\s*button[^}]*white-space:\s*nowrap/s)
  assert.match(styles, /@media\s*\(max-width:\s*1500px\)[\s\S]*\.page-heading\.action-heading[^}]*flex-direction:\s*column/s)
})

test('侧栏品牌与启动动画使用统一应用图标', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8')
  assert.match(source, /import appIconImage from '\.\/assets\/app-icon\.png'/)
  assert.match(source, /className="brand-mark" src=\{appIconImage\}/)
  assert.match(source, /className="launch-brand-image" src=\{appIconImage\}/)
})
