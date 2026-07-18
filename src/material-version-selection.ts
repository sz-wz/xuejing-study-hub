export type MaterialVersionSelectionGroup = {
  materialId: string
  relation: 'single' | 'versions' | 'source-conflict'
  activePath: string
  recommendedPath: string
}

function normalizedPath(value: string) {
  return value.replace(/\\/g, '/').toLocaleLowerCase()
}

export function recommendedVersionChanges(groups: MaterialVersionSelectionGroup[], appliedSignatures: ReadonlySet<string>) {
  const replacements = new Map<string, string>()
  const signatures: string[] = []
  for (const group of groups) {
    if (group.relation !== 'versions' || normalizedPath(group.activePath) === normalizedPath(group.recommendedPath)) continue
    const signature = `${group.materialId}:${normalizedPath(group.recommendedPath)}`
    if (appliedSignatures.has(signature)) continue
    replacements.set(group.materialId, group.recommendedPath)
    signatures.push(signature)
  }
  return { replacements, signatures }
}
