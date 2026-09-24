import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Builds a THIRD_PARTY_LICENSES text for the npm packages whose files were
 * bundled. `files` are module paths as reported by the bundler.
 */
export function thirdPartyLicenses(files, intro) {
  const packages = new Map()
  for (const file of files) {
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(file.replace(/\\/g, '/'))
    if (!match) continue
    const dir = resolve(match[1])
    if (packages.has(dir)) continue
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const licenseFile = readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f))
    const header = `${pkg.name}@${pkg.version} (${pkg.license})`
    if (!licenseFile) throw new Error(`no license file found for ${header}`)
    packages.set(dir, { header, text: readFileSync(join(dir, licenseFile), 'utf8').trim() })
  }
  const sections = [...packages.values()]
    .sort((a, b) => a.header.localeCompare(b.header))
    .map((p) => `${p.header}\n${'-'.repeat(p.header.length)}\n\n${p.text}\n`)
  return `${intro}\n\n${sections.join('\n')}`
}
