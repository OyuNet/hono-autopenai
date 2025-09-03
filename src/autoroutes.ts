import * as path from 'node:path'
import * as fs from 'node:fs'

export interface AutoroutesOptions {
  rootDirAbs: string
}

export function isRouteFile(filePath: string): boolean {
  return path.basename(filePath) === 'route.ts' || path.basename(filePath) === 'route.tsx'
}

export function computeAutoroutePrefix(filePath: string, opts: AutoroutesOptions): string | undefined {
  const dir = path.dirname(filePath)
  const rel = path.relative(opts.rootDirAbs, dir)
  if (rel.startsWith('..')) return undefined
  if (rel === '') return '/'
  const parts = rel.split(path.sep).filter(Boolean)
  return '/' + parts.join('/')
}

export function joinRoutePaths(prefix: string | undefined, local: string): string {
  if (!prefix || prefix === '/' || prefix === '') return normalizeLocal(local)
  const p = prefix.replace(/\/+$/, '')
  const l = local.replace(/^\/+/, '')
  if (l === '' || l === '/') return p
  return `${p}/${l}`
}

function normalizeLocal(local: string): string {
  if (!local) return '/'
  // Ensure it starts with '/'
  return local.startsWith('/') ? local : `/${local}`
}

export function findMiddlewareScopes(filePath: string, opts: AutoroutesOptions): string[] {
  // Walk from route file directory up to rootDirAbs, collect folders containing middleware.ts
  const scopes: string[] = []
  let cur = path.dirname(filePath)
  const stop = path.resolve(opts.rootDirAbs)
  while (true) {
    const mid = path.join(cur, 'middleware.ts')
    if (fs.existsSync(mid)) {
      const rel = path.relative(opts.rootDirAbs, cur)
      const prefix = rel ? `/${rel.split(path.sep).filter(Boolean).join('/')}` : '/'
      scopes.push(prefix)
    }
    if (cur === stop) break
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
    // If we've moved outside root, stop
    if (path.relative(stop, cur).startsWith('..')) break
  }
  // Sort shallow to deep for readability
  scopes.sort((a, b) => a.split('/').length - b.split('/').length)
  return scopes
}
