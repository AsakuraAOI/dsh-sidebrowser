import { readFileSync, writeFileSync } from 'node:fs'
const root = new URL('../', import.meta.url)
const template = readFileSync(new URL('src/client-template.js', root), 'utf8')
const helpers = readFileSync(new URL('src/page-extensions.js', root), 'utf8').replace(/^export /gm, '')
const driver = readFileSync(new URL('src/driver-extensions.js', root), 'utf8')
const visuals = readFileSync(new URL('src/visual-feedback.js', root), 'utf8')
if (!template.includes('/* PAGE_EXTENSIONS */')) throw new Error('Missing page helper build slot')
writeFileSync(new URL('client.js', root), template.replace('/* PAGE_EXTENSIONS */', helpers).replace('/* DRIVER_EXTENSIONS */', visuals + '\n' + driver))
