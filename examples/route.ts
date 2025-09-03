import { Hono } from 'hono'

const app = new Hono()
app.get('/', (c) => c.text('Hello root!'))
export default app
