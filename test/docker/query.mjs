import { readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'

const target = new URL(process.argv[2] ?? 'https://test-cloud:8443/health')
const method = process.argv[3] ?? 'GET'
const body = process.argv[4]
const transport = target.protocol === 'https:' ? https : http
const options = {
  method,
  headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : undefined,
  ...(target.protocol === 'https:' ? { ca: readFileSync('/certs/ca.crt') } : {})
}

const response = await new Promise((resolve, reject) => {
  const request = transport.request(target, options, (incoming) => {
    const chunks = []
    incoming.on('data', (chunk) => chunks.push(chunk))
    incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
  })
  request.on('error', reject)
  if (body) request.write(body)
  request.end()
})

if (response.status < 200 || response.status >= 300) {
  process.stderr.write(`HTTP ${response.status}: ${response.body}\n`)
  process.exit(1)
}
process.stdout.write(response.body)
