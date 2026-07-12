const test = require('node:test')
const assert = require('node:assert/strict')
const { extractAssignmentText } = require('./assignment-analysis.cjs')

test('作业说明提取会去除页面导航和脚本，仅保留可分析文本', () => {
  const text = extractAssignmentText(`
    <nav>Blackboard 首页 课程工具</nav>
    <main><h1>Homework 2</h1><section><h2>Instructions</h2><p>Calculate the convolution of x[n] and h[n].</p></section></main>
    <script>window.secret = 'do not include'</script>
  `)
  assert.match(text, /Instructions Calculate the convolution/)
  assert.doesNotMatch(text, /Blackboard 首页|do not include/)
})
