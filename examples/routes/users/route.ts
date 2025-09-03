import { Hono } from 'hono'

const app = new Hono()
app.get('/:id', (c) => c.json({ user: c.req.param('id') }))
export default app
