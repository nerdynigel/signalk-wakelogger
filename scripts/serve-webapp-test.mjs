// Disposable browser-test server; never used by the packaged plugin.
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('../public/', import.meta.url)))
const port = Number(process.env.WAKELOGGER_WEBAPP_TEST_PORT || 4178)
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' }
http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://localhost')
    let pathname = decodeURIComponent(url.pathname)
    pathname = pathname.replace(/^\/signalk-wakelogger(?=\/|$)/, '')
    if (!pathname || pathname.endsWith('/')) pathname += 'index.html'
    const target = path.resolve(root, `.${pathname}`)
    if (!target.startsWith(`${root}${path.sep}`) && target !== root) {
      response.writeHead(403).end()
      return
    }
    const bytes = await readFile(target)
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(target)] || 'application/octet-stream' }).end(bytes)
  } catch {
    response.writeHead(404).end()
  }
}).listen(port, '127.0.0.1')
