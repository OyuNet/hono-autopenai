import { Hono } from 'hono'
import { mountDocs } from '../src/index'

const app = new Hono()

// Example: generate from autoroutes examples
mountDocs(app, {
  entries: 'examples/routes/**/route.ts',
  root: 'examples/routes',
  docsPath: '/docs',
  jsonPath: '/openapi.json',
  title: 'Example API',
  refreshOnRequest: true,
})

export default app
