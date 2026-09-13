import { mkdir, cp } from 'node:fs/promises'
const root = new URL('../', import.meta.url)
await mkdir(new URL('public/vendor/images/', root), { recursive: true })
await cp(new URL('webapp/', root), new URL('public/', root), { recursive: true })
for (const file of ['leaflet.js', 'leaflet.css']) await cp(new URL(`node_modules/leaflet/dist/${file}`, root), new URL(`public/vendor/${file}`, root))
await cp(new URL('node_modules/leaflet/dist/images/', root), new URL('public/vendor/images/', root), { recursive: true })
await cp(new URL('node_modules/leaflet/LICENSE', root), new URL('public/vendor/LEAFLET-LICENSE', root))
