import JSZip from 'jszip'

export type PptxElement = {
  kind: 'text' | 'image'
  left: number
  top: number
  width: number
  height: number
  text?: string
  src?: string
}

export type PptxSlide = { index: number; width: number; height: number; elements: PptxElement[] }

function children(element: Element, name: string) {
  return Array.from(element.children).filter((child) => child.localName === name)
}

function descendant(element: Element, name: string) {
  return Array.from(element.getElementsByTagNameNS('*', name))[0]
}

function geometry(element: Element, width: number, height: number) {
  const transform = descendant(element, 'xfrm')
  const offset = transform && children(transform, 'off')[0]
  const extent = transform && children(transform, 'ext')[0]
  const number = (value: string | null) => Number(value ?? 0)
  return {
    left: number(offset?.getAttribute('x') ?? null) / width * 100,
    top: number(offset?.getAttribute('y') ?? null) / height * 100,
    width: number(extent?.getAttribute('cx') ?? null) / width * 100,
    height: number(extent?.getAttribute('cy') ?? null) / height * 100,
  }
}

function relationshipTarget(value: string) {
  return `ppt/slides/${value}`.replace(/\\/g, '/').replace(/\/[^/]+\/\.\.\//g, '/')
}

async function parseSlide(zip: JSZip, entry: string, index: number, width: number, height: number): Promise<PptxSlide> {
  const xml = await zip.file(entry)?.async('text')
  if (!xml) return { index, width, height, elements: [] }
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  const relationshipEntry = entry.replace('slides/', 'slides/_rels/') + '.rels'
  const relationshipsXml = await zip.file(relationshipEntry)?.async('text')
  const relationshipDocument = relationshipsXml ? new DOMParser().parseFromString(relationshipsXml, 'application/xml') : null
  const relationships = new Map(Array.from(relationshipDocument?.getElementsByTagNameNS('*', 'Relationship') ?? []).map((relationship) => [relationship.getAttribute('Id') ?? '', relationshipTarget(relationship.getAttribute('Target') ?? '')]))
  const elements: PptxElement[] = []

  for (const shape of Array.from(document.getElementsByTagNameNS('*', 'sp'))) {
    const paragraphs = Array.from(shape.getElementsByTagNameNS('*', 'p')).map((paragraph) => Array.from(paragraph.getElementsByTagNameNS('*', 't')).map((text) => text.textContent ?? '').join('')).filter(Boolean)
    const text = paragraphs.join('\n').trim()
    const box = geometry(shape, width, height)
    if (text && box.width > 0 && box.height > 0) elements.push({ kind: 'text', ...box, text })
  }

  for (const picture of Array.from(document.getElementsByTagNameNS('*', 'pic'))) {
    const blip = descendant(picture, 'blip')
    const relationshipId = blip?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed') ?? blip?.getAttribute('r:embed')
    const target = relationshipId ? relationships.get(relationshipId) : undefined
    const image = target ? zip.file(target) : null
    const box = geometry(picture, width, height)
    if (!image || box.width <= 0 || box.height <= 0) continue
    const extension = target?.split('.').pop()?.toLowerCase() ?? 'png'
    const mime = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : extension === 'gif' ? 'image/gif' : extension === 'svg' ? 'image/svg+xml' : 'image/png'
    elements.push({ kind: 'image', ...box, src: `data:${mime};base64,${await image.async('base64')}` })
  }

  return { index, width, height, elements }
}

export async function parsePptx(bytes: Uint8Array): Promise<PptxSlide[]> {
  const zip = await JSZip.loadAsync(bytes)
  const presentationXml = await zip.file('ppt/presentation.xml')?.async('text')
  const presentation = presentationXml ? new DOMParser().parseFromString(presentationXml, 'application/xml') : null
  const slideSize = presentation && Array.from(presentation.getElementsByTagNameNS('*', 'sldSz'))[0]
  const width = Number(slideSize?.getAttribute('cx') ?? 12192000)
  const height = Number(slideSize?.getAttribute('cy') ?? 6858000)
  const entries = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).sort((left, right) => Number(left.match(/slide(\d+)/i)?.[1]) - Number(right.match(/slide(\d+)/i)?.[1]))
  return Promise.all(entries.map((entry, index) => parseSlide(zip, entry, index + 1, width, height)))
}
