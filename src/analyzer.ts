import * as ts from 'typescript'
import type { Hono } from 'hono'

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'options' | 'head'

export interface RouteInfo {
  method: HttpMethod
  path: string
  // TypeScript type node text of c.json argument
  responseTypeText?: string
  // Best-effort JSON Schema inferred from TypeChecker
  responseSchema?: any
  // Request body (application/json) schema
  requestBodySchema?: any
  // Query parameters object schema
  querySchema?: any
  // Path parameters from ":id" style segments
  pathParams?: string[]
  // Collected responses with potential different status codes and media types
  responses?: Array<{ status: number; schema?: any; mediaType?: string; headers?: Record<string, any>; description?: string }>
  // In autoroutes mode, list of folder scopes that have middleware.ts applying to this route (e.g., ['/', '/users'])
  middlewareScopes?: string[]
}

export interface AnalyzeOptions {
  program: ts.Program
  sourceFile: ts.SourceFile
}

function isHonoRouteCall(node: ts.Node): { method: HttpMethod; path: string } | null {
  // Detect expressions like app.get('/users', (c)=>{ ... }) or router.post("/x", ...)
  if (!ts.isCallExpression(node)) return null
  const expr = node.expression
  if (!ts.isPropertyAccessExpression(expr)) return null
  const methodName = expr.name.getText()
  const methods: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head']
  if (!(methods as string[]).includes(methodName)) return null
  const firstArg = node.arguments[0]
  if (!firstArg || !ts.isStringLiteralLike(firstArg)) return null
  return { method: methodName as HttpMethod, path: firstArg.text }
}

function stripParensAndCasts(expr: ts.Expression): ts.Expression {
  let e: ts.Expression = expr
  // remove parentheses and 'as' casts repeatedly
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (ts.isParenthesizedExpression(e)) { e = e.expression }
  else if (ts.isAsExpression(e)) { e = e.expression }
  else if (ts.isTypeAssertionExpression(e)) { e = e.expression }
    else if (ts.isNonNullExpression(e)) { e = e.expression }
    else { break }
  }
  return e
}

function isCtxMember(base: ts.Expression, ctxName: string | undefined, member: string): boolean {
  const b = stripParensAndCasts(base)
  if (ts.isPropertyAccessExpression(b)) {
  const obj = stripParensAndCasts(b.expression as ts.Expression)
    const name = b.name.getText()
    if (name !== member) return false
    if (!ctxName) return true
    return ts.isIdentifier(obj) && obj.text === ctxName
  }
  return false
}

function isBooleanType(t: ts.Type) {
  return (t.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLike)) !== 0
}
function isNumberType(t: ts.Type) {
  return (t.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLike)) !== 0
}
function isStringType(t: ts.Type) {
  return (t.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLike)) !== 0
}

function getTypeName(checker: ts.TypeChecker, type: ts.Type): string | undefined {
  const sym = type.getSymbol() ?? (type as any).symbol
  return sym?.getName()
}

function isBinaryLikeType(checker: ts.TypeChecker, type: ts.Type): boolean {
  // Primitive/union narrowing
  if (type.isUnion()) return type.types.some((t) => isBinaryLikeType(checker, t))
  const name = getTypeName(checker, type)
  if (!name && (type.flags & ts.TypeFlags.Object) === 0) return false
  const str = checker.typeToString(type)
  // Common binary/stream/body types
  const named = new Set([
    'ArrayBuffer',
    'SharedArrayBuffer',
    'Uint8Array', 'Uint8ClampedArray', 'Int8Array', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'BigInt64Array', 'BigUint64Array', 'Float32Array', 'Float64Array',
    'ReadableStream',
    'Blob',
    'File',
    'FormData',
  ])
  if (name && named.has(name)) return true
  if (/^ReadableStream(<.*>)?$/.test(str)) return true
  if (/ArrayBuffer(View)?/.test(str)) return true
  if (/Uint8Array|Int8Array|Float(32|64)Array|Big(Uint)?64Array/.test(str)) return true
  return false
}

function typeToSchema(checker: ts.TypeChecker, type: ts.Type, seen = new Set<ts.Type>()): any {
  // Handle union with undefined/null for nullable
  if (type.isUnion()) {
    const parts = type.types
    const nullish = parts.some((t) => (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !== 0)
    const nonNullish = parts.filter((t) => (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0)
    if (nonNullish.length === 1) {
      const only = nonNullish[0]!
      const s = typeToSchema(checker, only, seen)
      if (nullish && s) s.nullable = true
      return s
    }
    const anyOfRaw = nonNullish.map((t) => typeToSchema(checker, t, seen))
    const uniq: any[] = []
    const seenKeys = new Set<string>()
    for (const s of anyOfRaw) {
      const key = JSON.stringify(s)
      if (!seenKeys.has(key)) {
        seenKeys.add(key)
        uniq.push(s)
      }
    }
    return { anyOf: uniq, nullable: nullish || undefined }
  }

  if (isStringType(type)) return { type: 'string' }
  if (isNumberType(type)) return { type: 'number' }
  if (isBooleanType(type)) return { type: 'boolean' }

  // Array detection
  const arrayType = checker.getIndexTypeOfType(type, ts.IndexKind.Number)
  if (arrayType) {
    return { type: 'array', items: typeToSchema(checker, arrayType, seen) }
  }

  // Object-like
  if ((type.getFlags() & ts.TypeFlags.Object) !== 0) {
    if (seen.has(type)) return { description: '...recursive...' }
    seen.add(type)
    const props = checker.getPropertiesOfType(type)
    const properties: Record<string, any> = {}
    const required: string[] = []
    for (const sym of props) {
      const name = sym.getName()
      const decl = sym.valueDeclaration ?? sym.declarations?.[0]
      const isOptional = !!(decl && (ts.isParameter(decl) || ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl)) && decl.questionToken)
      const pType = checker.getTypeOfSymbol(sym)
      properties[name] = typeToSchema(checker, pType, seen)
      if (!isOptional) required.push(name)
    }
    const schema: any = { type: 'object', properties }
    if (required.length) schema.required = required
    return schema
  }

  // Fallback to type string
  return { description: `Unparsed type: ${checker.typeToString(type)}` }
}

function findResponses(checker: ts.TypeChecker, cb: ts.Expression | undefined, paramName?: string): Array<{ text?: string; schema?: any; status?: number; mediaType?: string; headers?: Record<string, any> }> {
  // Heuristic: look for "return c.json(<expr>)" or just "c.json(<expr>)" inside function body
  if (!cb) return []
  const results: Array<{ text?: string; schema?: any; status?: number; mediaType?: string; headers?: Record<string, any> }> = []
  const explicitContentType = findExplicitContentType(checker, cb, paramName)
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const expr = node.expression
      if (ts.isPropertyAccessExpression(expr)) {
        const callName = expr.name.getText()
        const base = stripParensAndCasts(expr.expression)
        const isCtx = (() => {
          if (!paramName) return true // best-effort fallback
          if (ts.isIdentifier(base)) return base.text === paramName
          if (ts.isPropertyAccessExpression(base) && ts.isIdentifier(base.expression)) return base.expression.text === paramName
          return false
        })()
        if (isCtx) {
          const a0 = node.arguments[0]
          const statusArg = node.arguments[1]
          const statuses = statusArg ? extractStatuses(checker, statusArg) : []
      if (callName === 'json') {
            if (a0) {
              const t = checker.getTypeAtLocation(a0)
              const text = checker.typeToString(t)
              const schema = typeToSchema(checker, t)
        const mt = explicitContentType || 'application/json'
        if (statuses.length) for (const s of statuses) results.push({ text, schema, status: s, mediaType: mt })
        else results.push({ text, schema, status: undefined, mediaType: mt })
            }
      } else if (callName === 'text') {
            // text/plain response
            const schema = { type: 'string' }
      const mt = explicitContentType || 'text/plain'
      if (statuses.length) for (const s of statuses) results.push({ schema, status: s, mediaType: mt })
      else results.push({ schema, status: undefined, mediaType: mt })
          } else if (callName === 'body') {
            // Infer if string => text/plain else binary
            let mediaType = explicitContentType || inferMediaTypeFromExpression(checker, a0) || 'application/octet-stream'
            let schema: any = { type: 'string', format: 'binary' }
            if (a0) {
              const t = checker.getTypeAtLocation(a0)
              if (isStringType(t)) {
        mediaType = explicitContentType || 'text/plain'
                schema = { type: 'string' }
              } else if (isBinaryLikeType(checker, t)) {
                mediaType = explicitContentType || mediaType || 'application/octet-stream'
                schema = { type: 'string', format: 'binary' }
              }
            }
            if (statuses.length) for (const s of statuses) results.push({ schema, status: s, mediaType })
            else results.push({ schema, status: undefined, mediaType })
          } else if (callName === 'html') {
            // text/html string response
            const schema = { type: 'string' }
      const mt = explicitContentType || 'text/html'
            if (statuses.length) for (const s of statuses) results.push({ schema, status: s, mediaType: mt })
            else results.push({ schema, status: undefined, mediaType: mt })
          } else if (callName === 'notFound') {
            // 404 without body
            const codeList = statuses.length ? statuses : [404]
            for (const s of codeList) results.push({ status: s, headers: undefined })
          } else if (callName === 'redirect') {
            // No content; add Location header, default 302
            const hdrs: Record<string, any> = { Location: { schema: { type: 'string', format: 'uri' } } }
            if (statuses.length) for (const s of statuses) results.push({ status: s, headers: hdrs })
            else results.push({ status: 302, headers: hdrs })
          }
        }
      }
    }
    // return new Response(body, { status, headers: { 'content-type': 'application/xml' } })
    if (ts.isReturnStatement(node) && node.expression && ts.isNewExpression(node.expression)) {
      const ne = node.expression
      const callee = ne.expression.getText()
      if (callee === 'Response') {
        const a0 = ne.arguments?.[0]
        const init = ne.arguments?.[1]
        const mediaType = inferMediaTypeFromResponseInit(init) || explicitContentType
        const statuses = extractStatusFromResponseInit(checker, init)
        let schema: any | undefined
        if (a0) {
          const t = checker.getTypeAtLocation(a0)
          if (isStringType(t)) schema = { type: 'string' }
          else if (isBinaryLikeType(checker, t) || inferMediaTypeFromExpression(checker, a0)) schema = { type: 'string', format: 'binary' }
        }
        const codes = statuses.length ? statuses : [200]
        for (const s of codes) results.push({ status: s, mediaType, schema })
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(cb, visit)
  return results
}

function extractStatuses(checker: ts.TypeChecker, expr: ts.Expression): number[] {
  const e = stripParensAndCasts(expr)
  if (ts.isNumericLiteral(e)) return [Number(e.text)]
  // Enum.Member -> try to resolve initializer
  if (ts.isPropertyAccessExpression(e)) {
    const val = tryGetEnumMemberValue(checker, e)
    if (typeof val === 'number') return [val]
  }
  const t = checker.getTypeAtLocation(e)
  const nums = numbersFromType(checker, t)
  return nums
}

function numbersFromType(checker: ts.TypeChecker, type: ts.Type): number[] {
  const out: number[] = []
  const addFrom = (tt: ts.Type) => {
    // Prefer number literal type
    if ((tt.flags & ts.TypeFlags.NumberLiteral) !== 0) {
      const v: any = tt as any
      if (typeof v.value === 'number') out.push(v.value)
      else {
        const s = checker.typeToString(tt)
        if (/^\d+$/.test(s)) out.push(parseInt(s, 10))
      }
      return
    }
    // If it's an enum literal that narrows to a specific numeric value, typeToString may still be digits
    const s = checker.typeToString(tt)
    if (/^\d+$/.test(s)) out.push(parseInt(s, 10))
  }
  if (type.isUnion()) {
    for (const tt of type.types) addFrom(tt)
  } else addFrom(type)
  // Dedup
  return Array.from(new Set(out))
}

function tryGetEnumMemberValue(checker: ts.TypeChecker, pae: ts.PropertyAccessExpression): number | undefined {
  const nameSym = checker.getSymbolAtLocation(pae.name)
  if (!nameSym) return undefined
  for (const d of nameSym.declarations ?? []) {
    if (ts.isEnumMember(d)) {
      const init = d.initializer
      if (!init) return undefined
      if (ts.isNumericLiteral(init)) return Number(init.text)
      if (ts.isPrefixUnaryExpression(init) && init.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(init.operand)) {
        return -Number(init.operand.text)
      }
    }
  }
  return undefined
}

function findExplicitContentType(checker: ts.TypeChecker, cb: ts.Expression, paramName?: string): string | undefined {
  let found: string | undefined
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const expr = node.expression
      if (ts.isPropertyAccessExpression(expr) && expr.name.getText() === 'header') {
        const base = expr.expression
        if (!paramName || (ts.isIdentifier(base) && base.text === paramName)) {
          const k = node.arguments[0]
          const v = node.arguments[1]
          if (k && v && ts.isStringLiteralLike(k)) {
            const key = k.text.toLowerCase()
            const val = resolveToStringLiteralText(checker, v as ts.Expression)
            if (key === 'content-type' && val) found = val
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(cb, visit)
  return found
}

function inferMediaTypeFromExpression(checker: ts.TypeChecker, expr?: ts.Expression): string | undefined {
  if (!expr) return undefined
  const e = stripParensAndCasts(expr)
  if (ts.isNewExpression(e)) {
    const name = e.expression.getText()
    // Blob or File: options.type
    if (name === 'Blob' || name === 'File') {
      const optionsArg = name === 'File' ? e.arguments?.[2] : e.arguments?.[1]
      if (optionsArg && ts.isObjectLiteralExpression(optionsArg)) {
        for (const p of optionsArg.properties) {
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'type' && ts.isStringLiteralLike(p.initializer)) {
            return p.initializer.text
          }
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'type' && ts.isExpression(p.initializer)) {
            const v = resolveToStringLiteralText(checker, p.initializer)
            if (v) return v
          }
        }
      }
    }
    // new Response(..., { headers: { 'content-type': '...' } }) handled elsewhere
  }
  return undefined
}

function inferMediaTypeFromResponseInit(init?: ts.Expression): string | undefined {
  if (!init || !ts.isObjectLiteralExpression(init)) return undefined
  for (const prop of init.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'headers') {
      const headers = prop.initializer
      if (ts.isObjectLiteralExpression(headers)) {
        for (const h of headers.properties) {
          if (ts.isPropertyAssignment(h)) {
            const key = ts.isIdentifier(h.name) ? h.name.text : ts.isStringLiteralLike(h.name) ? h.name.text : undefined
            if (key && key.toLowerCase() === 'content-type') {
              if (ts.isStringLiteralLike(h.initializer)) return h.initializer.text
              if (ts.isExpression(h.initializer)) {
                const v = resolveToStringLiteralText(undefined as any, h.initializer)
                if (v) return v
              }
            }
          }
        }
      }
    }
  }
  return undefined
}

function extractStatusFromResponseInit(checker: ts.TypeChecker, init?: ts.Expression): number[] {
  if (!init || !ts.isObjectLiteralExpression(init)) return []
  for (const prop of init.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'status') {
      return extractStatuses(checker, prop.initializer as ts.Expression)
    }
  }
  return []
}

function resolveToStringLiteralText(checker: ts.TypeChecker | undefined, expr: ts.Expression): string | undefined {
  // Best-effort: follow identifiers to their initializer and return string literal text
  let e: ts.Expression | undefined = stripParensAndCasts(expr)
  const seen = new Set<ts.Expression>()
  while (e && !seen.has(e)) {
    seen.add(e)
    if (ts.isStringLiteralLike(e)) return e.text
    if (ts.isNoSubstitutionTemplateLiteral?.(e as any)) return (e as any).text
    if (ts.isTemplateExpression(e)) {
      // Only simple template with no expressions
      if (e.templateSpans.length === 0) return e.head.text
      return undefined
    }
    if (ts.isIdentifier(e)) {
      const init = resolveIdentifierToInit(e)
      if (init && ts.isExpression(init)) { e = stripParensAndCasts(init); continue }
      // As a fallback, try typeToString if checker given and yields a literal-like value
      if (checker) {
        const t = checker.getTypeAtLocation(e)
        const s = (checker as any).typeToString?.(t)
        if (typeof s === 'string' && /^".*"$/.test(s)) return s.slice(1, -1)
      }
      return undefined
    }
    // Member access not supported for strings here
    return undefined
  }
  return undefined
}

export function analyzeSource({ program, sourceFile }: AnalyzeOptions): RouteInfo[] {
  const checker = program.getTypeChecker()
  const routes: RouteInfo[] = []
  const visit = (node: ts.Node) => {
    const route = isHonoRouteCall(node)
    if (route) {
      // Handler is usually the second argument
      const handler = (node as ts.CallExpression).arguments[1]
      let bodyNode: ts.Node | undefined
      let paramName: string | undefined
      if (handler) {
        if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) {
          bodyNode = handler.body
          // get first parameter name if identifier
          const p = handler.parameters?.[0]?.name
          if (p && ts.isIdentifier(p)) paramName = p.text
        }
      }
  const foundList = findResponses(checker, bodyNode as ts.Expression | undefined, paramName)
      const first = foundList[0]
      const req = findRequestData(checker, bodyNode as ts.Expression | undefined, paramName)
      const params = extractPathParams(route.path)
      routes.push({
        method: route.method,
        path: route.path,
        responseTypeText: first?.text,
        responseSchema: first?.schema,
        requestBodySchema: req.bodySchema,
        querySchema: req.querySchema,
        pathParams: params,
  responses: foundList.map((f) => ({ status: f.status ?? 200, schema: f.schema, mediaType: f.mediaType, headers: f.headers })),
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return routes
}

export function createProgramFromFiles(fileNames: string[]): ts.Program {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    strict: true,
    jsx: ts.JsxEmit.ReactJSX,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
  }
  return ts.createProgram({ rootNames: fileNames, options: compilerOptions })
}

function extractPathParams(path: string): string[] {
  const out: string[] = []
  const re = /:([A-Za-z0-9_]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(path))) out.push(m[1]!)
  return out
}

function findRequestData(checker: ts.TypeChecker, cb: ts.Expression | undefined, paramName?: string): { bodySchema?: any; querySchema?: any } {
  if (!cb) return {}
  let bodySchema: any | undefined
  const queryProps: Record<string, any> = {}
  const requiredQuery = new Set<string>()

  const visit = (node: ts.Node) => {
    // const v: T = await c.req.json() OR const v = await c.req.json()
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = stripParensAndCasts(node.initializer as ts.Expression)
      const considerTyped = () => {
        if (node.type) {
          const t = checker.getTypeFromTypeNode(node.type)
          return typeToSchema(checker, t)
        }
        return undefined
      }
      // await c.req.json()
      if ((ts.isAwaitExpression(init) && ts.isCallExpression(init.expression)) || ts.isCallExpression(init)) {
        const call = ts.isAwaitExpression(init) ? init.expression as ts.CallExpression : init
        if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.getText() === 'json' && isCtxMember(call.expression.expression, paramName, 'req')) {
          bodySchema ||= considerTyped() || typeToSchema(checker, checker.getTypeAtLocation(init))
        }
        if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.getText() === 'query' && isCtxMember(call.expression.expression, paramName, 'req')) {
          const typed = considerTyped()
          if (typed) mergeQuerySchemaFromObjectSchema(queryProps, requiredQuery, typed)
        }
      }
    }

    // schema.parse(await c.req.json()) where schema is z.object({...})
    if (ts.isCallExpression(node)) {
      const expr = node.expression
      if (ts.isPropertyAccessExpression(expr) && expr.name.getText() === 'parse') {
        const a0 = node.arguments[0]
        if (a0 && ts.isAwaitExpression(a0) && ts.isCallExpression(a0.expression)) {
          const innerCall = a0.expression
          if (ts.isPropertyAccessExpression(innerCall.expression) && innerCall.expression.name.getText() === 'json' && isCtxMember(innerCall.expression.expression, paramName, 'req')) {
            const schemaExpr = expr.expression
            const schemaInit = resolveIdentifierToInit(schemaExpr)
            if (schemaInit && ts.isCallExpression(schemaInit) && isZodObjectCall(schemaInit)) {
              const s = zodObjectCallToSchema(schemaInit)
              if (s) bodySchema ||= s
            }
          }
        }
      }

      // c.req.query('key')
      if (ts.isPropertyAccessExpression(expr) && expr.name.getText() === 'query' && isCtxMember(expr.expression, paramName, 'req')) {
        const a0 = node.arguments[0]
        if (a0 && ts.isStringLiteralLike(a0)) {
          const k = a0.text
          queryProps[k] = { type: 'string' }
        }
      }
    }

    ts.forEachChild(node, visit)
  }
  ts.forEachChild(cb, visit)

  const querySchema = Object.keys(queryProps).length
    ? { type: 'object', properties: queryProps, required: Array.from(requiredQuery) }
    : undefined

  return { bodySchema, querySchema }
}

function resolveIdentifierToInit(expr: ts.Expression): ts.Expression | undefined {
  const base = stripParensAndCasts(expr)
  if (ts.isIdentifier(base)) {
    const sym = (base as any).symbol as ts.Symbol | undefined
    const d = sym?.declarations?.[0]
    if (d && ts.isVariableDeclaration(d) && d.initializer && ts.isExpression(d.initializer)) return d.initializer
  }
  return undefined
}

function isZodObjectCall(call: ts.CallExpression): boolean {
  const callee = call.expression
  if (ts.isPropertyAccessExpression(callee)) {
    const obj = callee.expression.getText()
    const name = callee.name.getText()
    return (obj === 'z' || obj.endsWith('.z')) && name === 'object'
  }
  return false
}

function zodObjectCallToSchema(call: ts.CallExpression): any | undefined {
  const arg = call.arguments[0]
  if (!arg || !ts.isObjectLiteralExpression(arg)) return undefined
  const properties: Record<string, any> = {}
  const required: string[] = []
  for (const prop of arg.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
    const key = prop.name.text
    const schema = zodTypeExprToSchema(prop.initializer as ts.Expression)
    properties[key] = schema.schema
    if (!schema.optional) required.push(key)
  }
  const out: any = { type: 'object', properties }
  if (required.length) out.required = required
  return out
}

function zodTypeExprToSchema(expr: ts.Expression): { schema: any; optional: boolean } {
  // Support: z.string(), z.number(), z.boolean(), z.array(z.string()), .optional()
  let optional = false
  let cur: ts.Expression = expr
  const unwrap = (e: ts.Expression) => stripParensAndCasts(e)
  // unwrap chained .optional()
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression) && cur.expression.name.getText() === 'optional') {
    optional = true
    cur = cur.expression.expression
  }
  cur = unwrap(cur)
  if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    const recv = cur.expression.expression.getText()
    const name = cur.expression.name.getText()
    if (recv === 'z') {
      if (name === 'string') return { schema: { type: 'string' }, optional }
      if (name === 'number') return { schema: { type: 'number' }, optional }
      if (name === 'boolean') return { schema: { type: 'boolean' }, optional }
      if (name === 'array') {
        const inner = cur.arguments[0]
        const innerSchema = inner ? zodTypeExprToSchema(inner) : { schema: {} as any, optional: false }
        return { schema: { type: 'array', items: innerSchema.schema }, optional }
      }
      if (name === 'object') {
        const s = zodObjectCallToSchema(cur)
        return { schema: s ?? {}, optional }
      }
    }
  }
  return { schema: { description: 'Unparsed Zod schema' }, optional }
}

function mergeQuerySchemaFromObjectSchema(props: Record<string, any>, required: Set<string>, objSchema: any) {
  if (!objSchema || objSchema.type !== 'object' || !objSchema.properties) return
  for (const [k, v] of Object.entries(objSchema.properties)) {
    props[k] = v
  }
  if (Array.isArray(objSchema.required)) {
    for (const k of objSchema.required) required.add(String(k))
  }
}
