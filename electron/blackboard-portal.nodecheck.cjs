const assert = require('node:assert/strict')
const test = require('node:test')
const { classifyBlackboardPage, isBlackboardAuthenticatedPage, parseCourseLinks } = require('./blackboard-portal.cjs')
const { createSuccessfulLoginGate } = require('./blackboard-connection.cjs')
const { parseAttachments, parseContentLinks, parseExternalLinks } = require('./blackboard-content.cjs')
const { parseBlackboardAssignmentDetails } = require('./blackboard-assignment.cjs')

test('上海科技大学 Blackboard 首页应被视为已认证页面', () => {
  assert.equal(
    isBlackboardAuthenticatedPage('https://elearning.shanghaitech.edu.cn:8443/webapps/bb-BB-BBLEARN/index.jsp'),
    true,
  )
})

test('从课程启动链接中读取课程名称', () => {
  const courses = parseCourseLinks('<a href="/webapps/blackboard/execute/launcher?type=Course&id=_123_1">CS101 · Programming</a>')
  assert.deepEqual(courses, [{ name: 'CS101 · Programming', url: 'https://elearning.shanghaitech.edu.cn:8443/webapps/blackboard/execute/launcher?type=Course&id=_123_1' }])
})

test('含“总课程列表”的 Blackboard 首页应从 HTML 内容识别，而非依赖 response.url', () => {
  const html = '<h2>总课程列表 (All Course List)</h2><a href="/webapps/blackboard/execute/launcher?type=Course&id=_123_1">CS101</a>'
  assert.equal(classifyBlackboardPage(html), 'blackboard-home')
})

test('同一个登录成功地址重复导航时只完成一次连接', () => {
  let connectedEvents = 0
  const gate = createSuccessfulLoginGate(() => { connectedEvents += 1 })
  const home = 'https://elearning.shanghaitech.edu.cn:8443/webapps/bb-BB-BBLEARN/index.jsp'

  gate.reportNavigation(home)
  gate.reportNavigation(home)
  gate.reportNavigation(home)

  assert.equal(connectedEvents, 1)
})

test('从 Blackboard 内容首页读取 Slides 等资料文件夹', () => {
  const html = '<a href="/webapps/blackboard/content/listContent.jsp?course_id=_5006_1&content_id=_154922_1">Slides</a>'
  const folders = parseContentLinks(html, 'https://elearning.shanghaitech.edu.cn:8443/webapps/blackboard/content/listContent.jsp?course_id=_5006_1&content_id=_154918_1')

  assert.deepEqual(folders, [{
    title: 'Slides',
    url: 'https://elearning.shanghaitech.edu.cn:8443/webapps/blackboard/content/listContent.jsp?course_id=_5006_1&content_id=_154922_1',
  }])
})

test('从 Blackboard Slides 页面读取 PPT 附件元数据', () => {
  const html = '<a href="/bbcswebdav/pid-5006-dt-content-rid-1_1/xid-5006_1">ch1.ppt (3.377 MB)</a>'
  const attachments = parseAttachments(html, 'https://elearning.shanghaitech.edu.cn:8443/webapps/blackboard/content/listContent.jsp?course_id=_5006_1&content_id=_154922_1')

  assert.deepEqual(attachments, [{
    title: 'ch1.ppt',
    type: 'PPT',
    url: 'https://elearning.shanghaitech.edu.cn:8443/bbcswebdav/pid-5006-dt-content-rid-1_1/xid-5006_1',
    meta: '3.377 MB',
  }])
})

test('课程文件标题没有扩展名时，仍应识别 Blackboard 的下载链接', () => {
  const html = '<a href="/bbcswebdav/pid-5006-dt-content-rid-1_1/xid-5006_1">第一周_亲密关系心理学课程介绍</a>'
  const attachments = parseAttachments(html, 'https://elearning.shanghaitech.edu.cn:8443/webapps/blackboard/content/listContent.jsp?course_id=_5006_1&content_id=_154922_1')

  assert.deepEqual(attachments, [{
    title: '第一周_亲密关系心理学课程介绍',
    type: '文件',
    url: 'https://elearning.shanghaitech.edu.cn:8443/bbcswebdav/pid-5006-dt-content-rid-1_1/xid-5006_1',
    meta: '',
  }])
})

test('保留 Blackboard 内容页中的外部学习链接', () => {
  const html = '<a href="https://www.proquest.com/eebo/docview/2240918305">Oroonoko 小说原文（EEBO链接）</a>'
  const links = parseExternalLinks(html, 'https://elearning.shanghaitech.edu.cn:8443/webapps/blackboard/content/listContent.jsp?course_id=_5311_1')

  assert.deepEqual(links, [{
    title: 'Oroonoko 小说原文（EEBO链接）', type: '网页', url: 'https://www.proquest.com/eebo/docview/2240918305', meta: 'www.proquest.com',
  }])
})

test('忽略 Blackboard 页脚与学校主页等导航外链', () => {
  const html = '<a href="https://www.blackboard.com">主页</a><a href="https://www.shanghaitech.edu.cn">Blackboard Learn</a><a href="https://example.org/course-video">课程公开视频</a>'
  const links = parseExternalLinks(html, 'https://elearning.shanghaitech.edu.cn:8443/webapps/blackboard/content/listContent.jsp?course_id=_5006_1')

  assert.deepEqual(links, [{ title: '课程公开视频', type: '网页', url: 'https://example.org/course-video', meta: 'example.org' }])
})

test('从 Blackboard 作业详情页读取中文截止日期和重新提交状态', () => {
  const html = '<h1>上传作业：重新提交作业窗口</h1><section><span>截止日期</span><strong>2026年6月23日 星期二 下午11:59</strong><span>满分</span><strong>100</strong></section>'
  assert.deepEqual(parseBlackboardAssignmentDetails(html), {
    dueAt: '2026-06-23T23:59:00+08:00',
    dueLabel: '2026年6月23日 下午11:59',
    status: 'submitted',
    maxScore: 100,
  })
})
