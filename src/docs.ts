import type { Hono } from 'hono'
import type { OpenAPIV3_1 as O } from 'openapi-types'
import { createProgramFromFiles, analyzeSource, type RouteInfo } from './analyzer'
import { routesToOpenAPI } from './schema'
import { computeAutoroutePrefix, findMiddlewareScopes, isRouteFile, joinRoutePaths } from './autoroutes'

export interface MountDocsOptions {
  // Provide an OpenAPI document or a function that returns one
  document?: O.Document | (() => O.Document | Promise<O.Document>)
  // Or generate from source entries (globs), optionally with autoroutes root
  entries?: string | string[]
  root?: string
  // Route paths
  docsPath?: string // default '/docs'
  jsonPath?: string // default '/openapi.json'
  // Page title
  title?: string
  // If true, regenerate the document on each request when using entries
  refreshOnRequest?: boolean
}

export function mountDocs(app: Hono, opts: MountDocsOptions = {}) {
  const docsPath = normalizePath(opts.docsPath ?? '/docs')
  const jsonPath = normalizePath(opts.jsonPath ?? '/openapi.json')
  const title = opts.title ?? 'API Docs'

  let cachedDocPromise: Promise<O.Document> | null = null

  const resolveDoc = async (): Promise<O.Document> => {
    if (typeof opts.document === 'function') {
      return await opts.document()
    }
    if (opts.document) return opts.document
    // Build from entries if provided
    if (opts.entries) {
      if (opts.refreshOnRequest) {
        return await buildFromEntries(opts.entries, opts.root)
      }
      if (!cachedDocPromise) cachedDocPromise = buildFromEntries(opts.entries, opts.root)
      return await cachedDocPromise
    }
    throw new Error('mountDocs: provide either options.document or options.entries to generate the OpenAPI document')
  }

  // JSON spec route
  app.get(jsonPath, async (c) => {
    const doc = await resolveDoc()
    return c.json(doc)
  })

  // Swagger UI HTML route
  app.get(docsPath, (c) => {
    const html = renderSwaggerUI({ title, jsonUrl: jsonPath })
    return c.html(html)
  })
}

async function buildFromEntries(entries: string | string[], root?: string): Promise<O.Document> {
  const { default: fg } = await import('fast-glob')
  const patterns = Array.isArray(entries) ? entries : [entries]
  const files = await fg(patterns, { absolute: true })
  if (!files.length) throw new Error(`mountDocs: no files matched: ${patterns.join(', ')}`)
  const program = createProgramFromFiles(files)
  const rootAbs = root ? (await import('node:path')).resolve(process.cwd(), root) : ''
  const routes: RouteInfo[] = files.flatMap((f) => {
    const sf = program.getSourceFile(f)
    if (!sf) return []
    let rs = analyzeSource({ program, sourceFile: sf })
    if (rootAbs && isRouteFile(f)) {
      const prefix = computeAutoroutePrefix(f, { rootDirAbs: rootAbs })
      if (prefix) {
        const scopes = findMiddlewareScopes(f, { rootDirAbs: rootAbs })
        rs = rs.map((r) => ({ ...r, path: joinRoutePaths(prefix, r.path), middlewareScopes: scopes }))
      }
    }
    return rs
  })
  return routesToOpenAPI(routes)
}

function normalizePath(p: string): string {
  if (!p.startsWith('/')) return `/${p}`
  return p
}

function renderSwaggerUI({ title, jsonUrl }: { title: string; jsonUrl: string }): string {
  // Minimal HTML page that loads Swagger UI from a CDN
  // Uses Swagger UI v5 assets
  const css = 'https://unpkg.com/swagger-ui-dist@5/swagger-ui.css'
  const js = 'https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js'
  const jsPreset = 'https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js'
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="${css}">
    <style>body { margin: 0; padding: 0; } #swagger-ui { box-sizing: border-box; }</style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${js}"></script>
    <script src="${jsPreset}"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: '${jsonUrl}',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: 'StandaloneLayout'
      })
    </script>
  </body>
 </html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string))
}
