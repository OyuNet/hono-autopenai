// Minimal Hono-like example shape; we don't actually import hono to avoid runtime dep.
class HonoMock {
  routes: any[] = []
  get(path: string, handler: (c: any) => any) {
    this.routes.push(['get', path, handler])
  }
  post(path: string, handler: (c: any) => any) {
    this.routes.push(['post', path, handler])
  }
}

const app = new HonoMock()

app.get('/ping', (c) => {
  return (c as any).json({ ok: true })
})

app.get('/txt', (c) => {
  return (c as any).text('hello world')
})

app.get('/bin', (c) => {
  const buf = new Uint8Array([1,2,3])
  return (c as any).body(buf)
})

app.get('/go', (c) => {
  return (c as any).redirect('https://example.com', 301)
})

app.get('/ab', (c) => {
  const ab = new ArrayBuffer(8)
  return (c as any).body(ab)
})

app.get('/stream', (c) => {
  const rs = new ReadableStream({ start(controller) { controller.close() } })
  return new Response(rs, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
})

app.get('/page', (c) => {
  return (c as any).html('<h1>Hello</h1>')
})

app.get('/missing', (c) => {
  return (c as any).notFound()
})

type User = { id: string; name: string; age?: number }
app.post('/users/:id', async (c) => {
  // simulate zod usage
  const z = {
    object: (o: any) => ({ o, parse: (x: any) => x }),
    string: () => ({ optional: () => ({}) }),
    number: () => ({})
  } as any
  const schema = z.object({ name: z.string(), age: z.number().optional() })
  const body = schema.parse(await (c as any).req.json())
  type Q = { page?: string }
  const q: Q = (c as any).req.query()
  const created: User = { id: '1', name: body.name }
  if (!created.name) {
    type ErrStatus = 400 | 422
    const status: ErrStatus = 422
    return (c as any).json({ error: 'Bad Request' }, status)
  }
  enum S { Created = 201 }
  return (c as any).json(created, S.Created)
})

export default app
