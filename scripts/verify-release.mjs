import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
if (typeof packageJson.version !== 'string' || !/-beta\.[0-9]+$/.test(packageJson.version)) {
  throw new Error('Only -beta.N package versions may be published by the current release process')
}
if (process.env.npm_config_tag !== 'beta') {
  throw new Error('Refusing publication without the explicit npm --tag beta option')
}

