import { createProgramFromFiles, analyzeSource } from './analyzer'
import { routesToOpenAPI } from './schema'
import fg from 'fast-glob'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { computeAutoroutePrefix, isRouteFile, joinRoutePaths, findMiddlewareScopes } from './autoroutes'

type ArgMap = Record<string, string | boolean>
function parseArgs(argv: string[]): ArgMap {
  const args: ArgMap = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a.startsWith('--')) {
      const [kRaw, vRaw] = a.split('=')
      const k = (kRaw ?? '').slice(2)
      if (vRaw !== undefined) args[k] = vRaw
      else if (i + 1 < argv.length && !(argv[i + 1] ?? '').startsWith('--')) {
        const next = argv[++i]
        if (next !== undefined) args[k] = next
      } else args[k] = true
    }
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv)
  const explicitEntries = typeof args.entries !== 'undefined'
  const rootDir = (args.root as string) || (args.autoroutes as string) || ''
  const entries = explicitEntries
    ? (args.entries as string)
    : (rootDir ? `${rootDir}/**/route.ts` : 'src/**/*.ts')
  const out = (args.out as string) || 'openapi.json'
  const files = await fg(entries, { absolute: true })
  if (!files.length) {
    console.error(`[hono-autopenapi] No files matched pattern: ${entries}`)
    process.exit(1)
  }
  const program = createProgramFromFiles(files)
  const rootAbs = rootDir ? path.resolve(process.cwd(), rootDir) : ''
  const routes = files.flatMap((f: string) => {
    const sf = program.getSourceFile(f)
    if (!sf) return []
    let rs = analyzeSource({ program, sourceFile: sf })
    // If autoroutes root provided and file is a route.ts within that tree, prefix its paths.
  if (rootAbs && isRouteFile(f)) {
      const prefix = computeAutoroutePrefix(f, { rootDirAbs: rootAbs })
      if (prefix) {
    const scopes = findMiddlewareScopes(f, { rootDirAbs: rootAbs })
    rs = rs.map((r) => ({ ...r, path: joinRoutePaths(prefix, r.path), middlewareScopes: scopes }))
      }
    }
    return rs
  })
  const openapi = routesToOpenAPI(routes)
  fs.writeFileSync(out, JSON.stringify(openapi, null, 2), 'utf-8')
  console.log(`[hono-autopenapi] Wrote ${out} with ${routes.length} routes`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
