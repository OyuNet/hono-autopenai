## hono-autopenapi

Generate OpenAPI schema by statically analyzing Hono routes and the types passed to `c.json()`.

### Install

```bash
bun install
```

### Build

```bash
bun run build
```

### CLI

```bash
node ./dist/cli.js --entries "src/**/*.ts" --out openapi.json
```

Flags:
- `--entries` Glob(s) for source files (default: `src/**/*.ts`)
- `--out` Output file (default: `openapi.json`)
- `--root` or `--autoroutes` Path to autoroutes root (e.g. `src/routes`). When provided, any matched `route.ts` inside this folder will have its local paths prefixed with the folder structure. Example: `src/routes/users/route.ts` with `app.get('/:id', ...)` becomes `/users/:id`.
- `--autorouter` Path to autorouter root (e.g. `src/app/(routes)`). File- and folder-based routing like Next.js:
	- Folders form the base path.
	- Dynamic segments: `[id]` -> `:id`, `[...slug]` -> `:slug`.
	- `index.ts` contributes no segment, while `get.ts`/`post.ts`/etc. map methods but still need handlers discovered in code.
	- The analyzer prefixes discovered Hono route paths with this base.

### Programmatic API

```ts
import { analyzeFilesToOpenAPI } from 'hono-autopenapi'

const openapi = await analyzeFilesToOpenAPI(['src/**/*.ts'])
console.log(JSON.stringify(openapi, null, 2))
```

With autoroutes/autorouter support:

```ts
import { analyzeToOpenAPI } from 'hono-autopenapi'

// autoroutes (route.ts under folders)
const openapiA = await analyzeToOpenAPI({
	entries: 'src/routes/**/route.ts',
	autoroutesRoot: 'src/routes',
})

// autorouter (folder-based like Next.js)
const openapiB = await analyzeToOpenAPI({
	entries: 'src/app/**/*.{ts,tsx}',
	autorouterRoot: 'src/app',
})
```

### Notes
- MVP focuses on responses returned via `c.json(...)` in route handlers like `app.get('/path', (c) => c.json({...}))`.
- Types are inferred via TypeScript's type checker; common primitives, arrays, and object shapes are supported.
- Future: components `$ref` dedup, nested router composition, deeper Zod/TS coverage.

## Built-in Docs Route (/docs)

Expose Swagger UI and your OpenAPI JSON with a single helper.

```ts
import { Hono } from 'hono'
import { mountDocs } from 'hono-autopenapi'

const app = new Hono()

// Option A: Provide an OpenAPI document directly
mountDocs(app, {
	document: {
		openapi: '3.1.0',
		info: { title: 'My API', version: '1.0.0' },
		paths: {}
	},
})

// Option B: Generate from source entries (supports autoroutes root)
mountDocs(app, {
	entries: 'src/**/*.ts',
	root: 'src/routes',
	docsPath: '/docs',
	jsonPath: '/openapi.json',
	title: 'My API',
	refreshOnRequest: process.env.NODE_ENV !== 'production',
})

export default app
```

Routes:
- GET /openapi.json — serves the OpenAPI document
- GET /docs — serves Swagger UI that loads /openapi.json

