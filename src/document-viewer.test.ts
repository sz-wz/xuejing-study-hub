import { describe, expect, it } from 'vitest'
import { fitDocumentScale, stableDocumentScale } from './document-viewer'

describe('fitDocumentScale', () => {
  it('fits a page to the available width without exceeding the zoom limit', () => {
    expect(fitDocumentScale({ pageWidth: 600, pageHeight: 800, containerWidth: 944, containerHeight: 700, mode: 'width', padding: 44 })).toBe(1.5)
  })

  it('uses the smaller dimension when fitting the whole page', () => {
    expect(fitDocumentScale({ pageWidth: 600, pageHeight: 800, containerWidth: 944, containerHeight: 644, mode: 'page', padding: 44 })).toBe(0.75)
  })

  it('returns a safe default for an unmeasured container', () => {
    expect(fitDocumentScale({ pageWidth: 600, pageHeight: 800, containerWidth: 0, containerHeight: 0, mode: 'width' })).toBe(1)
  })
})

describe('stableDocumentScale', () => {
  it('ignores tiny ResizeObserver fluctuations that would otherwise trigger repeated PDF renders', () => {
    expect(stableDocumentScale(1.234, 1.241)).toBe(1.234)
    expect(stableDocumentScale(1.234, 1.28)).toBe(1.28)
  })

  it('settles scrollbar-width fit oscillation on the smaller safe scale', () => {
    expect(stableDocumentScale(0.62, 0.64)).toBe(0.62)
    expect(stableDocumentScale(0.64, 0.62)).toBe(0.62)
  })
})
