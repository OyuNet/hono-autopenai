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
