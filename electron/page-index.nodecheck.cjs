const assert = require('node:assert/strict')
const test = require('node:test')
const { applyLocationOverrides, buildPageCards, cloudRangesForConcept, localPageMapping, normalizedFormula } = require('./page-index.cjs')

test('公式规范化可以跨越数学字体、异常空格和括号差异定位页面', () => {
  const cards = buildPageCards([
    { kind: 'pdf-page', start: 14, end: 14, text: '14 Group Delay\nτ ( ω ) = − d / d ω ∠ 𝐻 ( j ω )' },
    { kind: 'pdf-page', start: 15, end: 15, text: '15 Group Delay\nExample and interpretation' },
  ])
  assert.equal(normalizedFormula('τ(ω)=−d/dω{∠H(jω)}'), normalizedFormula('τ ( ω ) = - d / d ω ∠ 𝐻 ( j ω )'))
  const result = localPageMapping({ title: '群延迟', evidence: 'τ(ω)=−d/dω{∠H(jω)}' }, cards, 'lecture')
  assert.deepEqual(result.locations.map((location) => [location.start, location.end, location.method]), [[14, 14, 'formula']])
})

test('云端页面映射按置信度区分已确认位置与待确认候选页', () => {
  const cards = buildPageCards([
    { kind: 'pdf-page', start: 12, text: '12 Linear Phase System' },
    { kind: 'pdf-page', start: 13, text: '13 Non-linear Phase System' },
    { kind: 'pdf-page', start: 27, text: '27 Ideal Low-pass Filters: Linear Phase' },
  ])
  const result = cloudRangesForConcept({ ranges: [
    { start: 12, end: 13, confidence: 0.94, reason: 'Linear Phase System' },
    { start: 27, end: 27, confidence: 0.68, reason: 'application' },
  ] }, cards, 'lecture')
  assert.deepEqual(result.locations.map((location) => [location.start, location.end]), [[12, 13]])
  assert.deepEqual(result.candidates.map((location) => [location.start, location.end, location.candidate]), [[27, 27, true]])
})

test('人工位置修正会覆盖自动结果并排除已拒绝候选页', () => {
  const concept = {
    title: '群延迟',
    locations: [{ materialId: 'lecture', kind: 'pdf-page', start: 14, end: 16, confidence: 0.9 }],
    locationCandidates: [{ materialId: 'lecture', kind: 'pdf-page', start: 20, end: 20, confidence: 0.65, candidate: true }],
  }
  const result = applyLocationOverrides(concept, {
    removed: [{ kind: 'pdf-page', start: 20, end: 20 }],
    added: [{ kind: 'pdf-page', start: 30, end: 31 }],
  }, 'lecture')
  assert.deepEqual(result.locations.map((location) => [location.start, location.end, location.method]), [[14, 16, undefined], [30, 31, 'manual']])
  assert.equal(result.locationCandidates.length, 0)
})
