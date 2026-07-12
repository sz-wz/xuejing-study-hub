const assert = require('node:assert/strict')
const test = require('node:test')
const { classifyGradescopePage, hasGradescopeSessionCookie, isGradescopeAuthenticatedPage, isGradescopeAssignmentResponseAuthenticated, parseGradescopeAssignments, parseGradescopeCourses } = require('./gradescope-portal.cjs')

test('只用 Gradescope 的认证会话恢复连接，不会把统计或防护 Cookie 误判为已登录', () => {
  assert.equal(hasGradescopeSessionCookie([{ name: '_gradescope_session' }]), true)
  assert.equal(hasGradescopeSessionCookie([{ name: 'signed_in' }]), true)
  assert.equal(hasGradescopeSessionCookie([{ name: '_ga' }, { name: 'csrf_token' }]), false)
})

test('Gradescope 课程主页与课程页可被识别为已登录页面', () => {
  assert.equal(isGradescopeAuthenticatedPage('https://www.gradescope.com/account'), true)
  assert.equal(isGradescopeAuthenticatedPage('https://www.gradescope.com/courses/1272330'), true)
  assert.equal(isGradescopeAuthenticatedPage('https://www.gradescope.com/login'), false)
})

test('Gradescope 登录完成必须由页面内容确认，不能只凭 /account 地址', () => {
  assert.equal(classifyGradescopePage('<main><h1>Log in to Gradescope</h1><input name="email" /></main>'), 'authentication')
  assert.equal(classifyGradescopePage('<main><h1>Course Dashboard</h1><h2>Your Courses</h2><a href="/courses/1272330">EE150.02</a></main>'), 'authenticated')
})

test('已批改作业详情页即使没有课程首页关键词，也不能被误判为登录失效', () => {
  const url = 'https://www.gradescope.com/courses/1272330/assignments/888001/submissions/12345'
  const gradedPage = '<main><h1>HW2</h1><span>Graded</span><aside>Total Points 97 / 100 Question 1 Exercise 1</aside></main>'
  assert.equal(classifyGradescopePage(gradedPage), 'unknown')
  assert.equal(isGradescopeAssignmentResponseAuthenticated(url, gradedPage), true)
  assert.equal(isGradescopeAssignmentResponseAuthenticated('https://www.gradescope.com/login', '<h1>Log in to Gradescope</h1>'), false)
})

test('从 Gradescope 课程主页读取课程入口', () => {
  const html = '<h2>Spring 2026</h2><a class="courseBox" href="/courses/1272330"><h3>EE150.02</h3><span>信号与系统2班</span></a><a href="/courses/new">Add a course</a><h2>Fall 2025</h2><a href="/courses/100"><h3>EE115A</h3></a>'
  assert.deepEqual(parseGradescopeCourses(html), [
    { name: 'EE150.02 信号与系统2班', term: 'Spring 2026', url: 'https://www.gradescope.com/courses/1272330' },
    { name: 'EE115A', term: 'Fall 2025', url: 'https://www.gradescope.com/courses/100' },
  ])
})

test('从 Gradescope 课程页读取作业提交入口', () => {
  const html = '<tr><td><a href="/courses/1272330/assignments/888001">HW8</a></td><td>100.0 / 100.0</td><td>Jun 19 at 3:12PM</td><td>Jul 25 at 11:59PM<br />Late Due Date: Jul 29 at 11:59PM</td></tr><tr><td><a href="/courses/1272330/assignments/888002/submissions/new">HW7</a></td><td>Submitted</td></tr>'
  assert.deepEqual(parseGradescopeAssignments(html, 'Spring 2026'), [
    { title: 'HW8', url: 'https://www.gradescope.com/courses/1272330/assignments/888001', meta: 'Due Jul 25 at 11:59PM', dueAt: '2026-07-25T23:59:00+08:00', status: 'graded', score: 100, maxScore: 100 },
    { title: 'HW7', url: 'https://www.gradescope.com/courses/1272330/assignments/888002/submissions/new', meta: 'Gradescope 作业', dueAt: undefined, status: 'submitted', score: undefined, maxScore: undefined },
  ])
})
