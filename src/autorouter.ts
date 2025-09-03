import * as path from 'node:path'

const METHOD_NAMES = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const
export type MethodName = typeof METHOD_NAMES[number]

export function isMethodFile(baseName: string): MethodName | undefined {
  const lower = baseName.toLowerCase()
  return (METHOD_NAMES as readonly string[]).includes(lower) ? (lower as MethodName) : undefined
}

export function computeAutorouterPath(rootDirAbs: string, fileAbs: string): string | undefined {
  const rel = path.relative(rootDirAbs, fileAbs)
  if (rel.startsWith('..')) return undefined
  const parsed = path.parse(rel)
  const segs = parsed.dir.split(path.sep).filter(Boolean)
  // If filename is neither index nor a method file, treat it as a final segment
  const base = parsed.name // without extension
  const methodInName = isMethodFile(base)
  if (!methodInName && base !== 'index') segs.push(base)
  const pathSegs = segs.map(convertSegment)
  const joined = '/' + pathSegs.filter(Boolean).join('/')
  return joined === '' ? '/' : joined
}

function convertSegment(s: string): string {
  // [id] -> :id, [...slug] -> :slug, [[...slug]] -> :slug (optional ignored here)
  if (s.startsWith('[') && s.endsWith(']')) {
    let name = s.slice(1, -1)
    if (name.startsWith('...')) name = name.slice(3)
    if (name.startsWith('[') && name.endsWith(']')) name = name.slice(1, -1) // [[...slug]]
    return `:${name}`
  }
  return s
}
