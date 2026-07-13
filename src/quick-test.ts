export type QuickTestQuestion = {
  id: string
  prompt: string
  options: string[]
  correctIndex: number
  explanation: string
  materialIds: string[]
  conceptIds: string[]
}

export type QuickTestRecord = {
  id: string
  scope: 'session' | 'current' | 'weak'
  questionCount: number
  questions: QuickTestQuestion[]
  answers: Record<string, number>
  status: 'ready' | 'completed'
  score?: number
  remainingMaterialIds?: string[]
  generatedAt: string
}

export function adaptiveQuestionCount(fileCount: number, unclearFileCount: number, weakConceptCount: number) {
  const base = Math.max(1, fileCount)
  return Math.min(10, Math.max(3, base + Math.ceil(unclearFileCount * .75) + Math.ceil(weakConceptCount / 3)))
}

function jsonObject(value: string) {
  return value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').match(/\{[\s\S]*\}/)?.[0]
}

export function parseQuickTest(value: string, allowedMaterialIds: string[], allowedConceptIds: string[], expectedCount: number): QuickTestQuestion[] {
  const raw = jsonObject(value)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed.questions)) return []
    const materials = new Set(allowedMaterialIds)
    const concepts = new Set(allowedConceptIds)
    return parsed.questions.flatMap((question: unknown, index: number) => {
      if (!question || typeof question !== 'object') return []
      const source = question as Record<string, unknown>
      const prompt = typeof source.prompt === 'string' ? source.prompt.trim() : ''
      const options = Array.isArray(source.options) ? source.options.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 4) : []
      const correctIndex = Number(source.correctIndex)
      const materialIds = Array.isArray(source.materialIds) ? source.materialIds.filter((id): id is string => typeof id === 'string' && materials.has(id)) : []
      const conceptIds = Array.isArray(source.conceptIds) ? source.conceptIds.filter((id): id is string => typeof id === 'string' && concepts.has(id)) : []
      if (!prompt || options.length < 2 || !Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length || !materialIds.length) return []
      return [{ id: `q-${index + 1}`, prompt, options, correctIndex, explanation: typeof source.explanation === 'string' ? source.explanation.trim() : '', materialIds: [...new Set(materialIds)], conceptIds: [...new Set(conceptIds)] }]
    }).slice(0, expectedCount)
  } catch {
    return []
  }
}

export function gradeQuickTest(test: QuickTestRecord, answers: Record<string, number>): QuickTestRecord {
  const correct = test.questions.filter((question) => answers[question.id] === question.correctIndex).length
  return { ...test, answers, status: 'completed', score: test.questions.length ? Math.round(correct / test.questions.length * 100) : 0 }
}
