function decodeHtml(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseBlackboardAssignmentDetails(html) {
  const text = decodeHtml(html)
  const match = text.match(/截止日期\s*(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日[^上下午]{0,24}(上午|下午)\s*(\d{1,2}):(\d{2})/)
  let dueAt
  let dueLabel
  if (match) {
    let hour = Number(match[5]) % 12
    if (match[4] === '下午') hour += 12
    dueAt = `${match[1]}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[3])).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${match[6]}:00+08:00`
    dueLabel = `${match[1]}年${match[2]}月${match[3]}日 ${match[4]}${match[5]}:${match[6]}`
  }
  const scoreMatch = text.match(/满分\s*(\d+(?:\.\d+)?)/)
  return {
    dueAt,
    dueLabel,
    status: /重新提交|已提交|提交记录|已上交/.test(text) ? 'submitted' : 'unknown',
    maxScore: scoreMatch ? Number(scoreMatch[1]) : undefined,
  }
}

module.exports = { parseBlackboardAssignmentDetails }
