import type { RouteInfo } from './analyzer'
import type { OpenAPIV3_1 as O } from 'openapi-types'

export type JsonSchema = O.SchemaObject | O.ReferenceObject | any

// Very small, heuristic converter from TS type string to JSON Schema.
// For an MVP we'll parse simple primitives, arrays, records, and object literal strings.
export function typeTextToSchema(typeText?: string): JsonSchema | undefined {
    if (!typeText) return undefined
    const t = typeText.trim()
    // Primitives
    if (t === 'string' || t === 'String') return { type: 'string' }
    if (t === 'number' || t === 'Number') return { type: 'number' }
    if (t === 'boolean' || t === 'Boolean') return { type: 'boolean' }
    if (t === 'null') return { type: 'null' }
    if (t === 'undefined' || t === 'void') return { nullable: true }

    // Array like: T[]
    const arrayMatch = t.match(/^(.*)\[]$/)
    if (arrayMatch && arrayMatch[1]) {
        return { type: 'array', items: typeTextToSchema(arrayMatch[1].trim()) ?? {} }
    }
    // Array<T>
    const arrayGeneric = t.match(/^Array<(.+)>$/)
    if (arrayGeneric && arrayGeneric[1]) {
        return { type: 'array', items: typeTextToSchema(arrayGeneric[1].trim()) ?? {} }
    }

    // Record<K,V>
    const recordGeneric = t.match(/^Record<\s*string\s*,\s*(.+)>$/)
    if (recordGeneric && recordGeneric[1]) {
        return { type: 'object', additionalProperties: typeTextToSchema(recordGeneric[1].trim()) ?? {} }
    }

    // Object literal rough parser: { a: string; b?: number }
    if (t.startsWith('{') && t.endsWith('}')) {
        const inner = t.slice(1, -1).trim()
        const props: Record<string, any> = {}
        const required: string[] = []
        // naive split by ; or ,
        const parts = inner.split(/[;,]\s*/).filter(Boolean)
        for (const part of parts) {
            const m = part.match(/^(\w+)(\?)?:\s*(.+)$/)
            if (m) {
                const name = m[1] as string
                const opt = Boolean(m[2])
                const vtype = m[3] as string
                props[name] = typeTextToSchema(vtype) ?? {}
                if (!opt) required.push(name)
            }
        }
        const schema: any = { type: 'object', properties: props }
        if (required.length) schema.required = required
        return schema
    }

    // Fallback
    return { description: `Unparsed type: ${t}` }
}

export function routesToOpenAPI(routes: RouteInfo[]): O.Document {
    const paths: O.PathsObject = {}
    for (const r of routes) {
        const method = r.method
        const path = toOpenApiPath(r.path)
        const schema = (r as any).responseSchema ?? typeTextToSchema(r.responseTypeText)
        paths[path] ??= {}
        const op: O.OperationObject = {}
        // Parameters: path params
        const parameters: (O.ParameterObject | O.ReferenceObject)[] = []
        if ((r as any).pathParams && Array.isArray((r as any).pathParams)) {
            for (const p of (r as any).pathParams as string[]) {
                parameters.push({ name: p, in: 'path', required: true, schema: { type: 'string' } })
            }
        }
        // Query params
        if ((r as any).querySchema && (r as any).querySchema.properties) {
            const props = (r as any).querySchema.properties
            const req = new Set<string>(Array.isArray((r as any).querySchema.required) ? (r as any).querySchema.required : [])
            for (const [name, s] of Object.entries(props)) {
                parameters.push({ name: name as string, in: 'query', required: req.has(name as string), schema: s as any })
            }
        }
        if (parameters.length) op.parameters = parameters

        // Middleware scopes as tags and description hint
        const scopes = (r as any).middlewareScopes as string[] | undefined
        if (Array.isArray(scopes) && scopes.length) {
            op.tags = scopes
            const note = `Middleware applied from: ${scopes.join(', ')}`
            op.description = op.description ? `${op.description}\n\n${note}` : note
        }

        // Request body
        if ((r as any).requestBodySchema) {
            op.requestBody = {
                required: true,
                content: { 'application/json': { schema: (r as any).requestBodySchema as O.SchemaObject } },
            }
        }

        const responses: Record<string, O.ResponseObject> = {}
        const collected = (r as any).responses as Array<{ status: number; schema?: any; mediaType?: string; headers?: Record<string, any> }> | undefined
        if (Array.isArray(collected) && collected.length) {
            for (const respItem of collected) {
                const code = String(respItem.status || 200)
                const ro: O.ResponseObject = { description: 'OK' }
                if (respItem.headers) ro.headers = respItem.headers as any
                if (respItem.schema) {
                    const mt = respItem.mediaType || 'application/json'
                    ro.content = { [mt]: { schema: respItem.schema as any } } as any
                }
                responses[code] = ro
            }
        } else {
            const ro: O.ResponseObject = { description: 'OK' }
            if (schema) ro.content = { 'application/json': { schema: schema as any } }
            responses['200'] = ro
        }
        op.responses = responses
            ; (paths[path] as any)[method] = op
    }

    return {
        openapi: '3.0.1',
        info: { title: 'hono-autopenapi', version: '0.1.0' },
        paths,
    }
}

function toOpenApiPath(honoPath: string): string {
    // Convert /users/:id -> /users/{id}
    return honoPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
}
