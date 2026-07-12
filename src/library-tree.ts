export function isFolderExpanded(expanded: ReadonlySet<string>, path: string) {
  return expanded.has(path)
}

export function toggledFolders(expanded: ReadonlySet<string>, path: string) {
  const next = new Set(expanded)
  if (next.has(path)) next.delete(path); else next.add(path)
  return next
}
