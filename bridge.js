import { currentConfig, reconfigure } from './index.js'

/** Cordis plugin name of the settings bridge. */
export const name = 'subagent-forge-bridge'

/** The web server is mandatory: without it the settings page has no data. */
export const inject = ['webServer']

const PREFIX = '/subagent-forge'
const MAX_BYTES = 256 * 1024

/** Send one JSON document. */
function send (res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** Accept only a loopback Host header: this route belongs to the local page. */
function loopback (req) {
  const host = String(req.headers.host ?? '')
  const hostname = host.replace(/:\d+$/u, '').replace(/^\[|\]$/gu, '')
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname.startsWith('127.')
}

/** Read one JSON request body with a hard size cap. */
function readBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BYTES) {
        reject(new Error('request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/**
 * Expose the plugin configuration to its own settings page.
 * @param ctx - owning context.
 */
export function apply (ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    async handler (req, res) {
      if (!loopback(req)) return send(res, 403, { error: 'not allowed' })

      const path = new URL(req.url ?? '/', 'http://localhost').pathname.slice(PREFIX.length) || '/'

      if (path === '/config' && req.method === 'GET') {
        const value = currentConfig()
        if (value === undefined) return send(res, 503, { error: 'the plugin is not active' })
        return send(res, 200, { value })
      }

      if (path === '/config' && req.method === 'POST') {
        try {
          const body = await readBody(req)
          if (body?.value === null || typeof body?.value !== 'object' || Array.isArray(body.value)) {
            return send(res, 400, { error: 'the request body must be {"value": {…}}' })
          }
          return send(res, 200, { value: reconfigure(body.value) })
        } catch (error) {
          return send(res, 400, { error: `invalid configuration: ${error.message}` })
        }
      }

      return send(res, 404, { error: 'not found' })
    },
  }))
}
