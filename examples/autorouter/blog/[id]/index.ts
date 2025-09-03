import { Hono } from 'hono'

const app = new Hono()
app.get('/', (c) => c.json({ postId: c.req.param('id') }))
export default app
