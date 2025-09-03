import type { MiddlewareHandler } from 'hono'

const mw: MiddlewareHandler = async (c, next) => {
  c.header('x-scope', 'root')
  await next()
}

export default mw
