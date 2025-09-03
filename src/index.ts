export { analyzeSource, createProgramFromFiles } from './analyzer'
export type { RouteInfo, HttpMethod } from './analyzer'
export { routesToOpenAPI, typeTextToSchema } from './schema'
export { mountDocs } from './docs'

export async function analyzeFilesToOpenAPI(fileGlobs: string | string[]) {
  const { default: fg } = await import('fast-glob')
  const patterns = Array.isArray(fileGlobs) ? fileGlobs : [fileGlobs]
  const files = await fg(patterns, { absolute: true })
  const { createProgramFromFiles, analyzeSource } = await import('./analyzer')
  const program = createProgramFromFiles(files)
  const routes = files.flatMap((file: string) => {
    const sf = program.getSourceFile(file)
    if (!sf) return []
    return analyzeSource({ program, sourceFile: sf })
  })
  const { routesToOpenAPI } = await import('./schema')
  return routesToOpenAPI(routes)
}

export interface AnalyzeToOpenAPIOptions {
  entries: string | string[]
  autoroutesRoot?: string
  autorouterRoot?: string
}

export async function analyzeToOpenAPI(opts: AnalyzeToOpenAPIOptions) {
  const { default: fg } = await import('fast-glob')
  const patterns = Array.isArray(opts.entries) ? opts.entries : [opts.entries]
  const files = await fg(patterns, { absolute: true, ignore: ['**/*.d.ts', '**/node_modules/**'] })
  const { createProgramFromFiles, analyzeSource } = await import('./analyzer')
  const program = createProgramFromFiles(files)
  const { computeAutoroutePrefix, isRouteFile, joinRoutePaths, findMiddlewareScopes } = await import('./autoroutes')
  const { computeAutorouterPath } = await import('./autorouter')
  const pathMod = await import('node:path')
  const rootAbsAutoroutes = opts.autoroutesRoot ? pathMod.resolve(process.cwd(), opts.autoroutesRoot) : ''
  const rootAbsAutorouter = opts.autorouterRoot ? pathMod.resolve(process.cwd(), opts.autorouterRoot) : ''
  const routes = files.flatMap((f: string) => {
    const sf = program.getSourceFile(f)
    if (!sf) return []
    let rs = analyzeSource({ program, sourceFile: sf })
    if (rootAbsAutoroutes && isRouteFile(f)) {
      const prefix = computeAutoroutePrefix(f, { rootDirAbs: rootAbsAutoroutes })
      if (prefix) {
        const scopes = findMiddlewareScopes(f, { rootDirAbs: rootAbsAutoroutes })
        rs = rs.map((r) => ({ ...r, path: joinRoutePaths(prefix, r.path), middlewareScopes: scopes }))
      }
    }
    if (rootAbsAutorouter) {
      const base = computeAutorouterPath(rootAbsAutorouter, f)
      if (base) rs = rs.map((r) => ({ ...r, path: joinRoutePaths(base, r.path) }))
    }
    return rs
  })
  const { routesToOpenAPI } = await import('./schema')
  return routesToOpenAPI(routes)
}
