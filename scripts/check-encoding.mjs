#!/usr/bin/env node
/**
 * Fail on a UTF-8 BOM or a CRLF in a shipped text file.
 * `npm run check` runs this script; it uses Node built-ins only.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root: this script lives in `<root>/scripts/`. */
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SKIP = new Set(['.git', 'node_modules'])
const TEXT = new Set(['.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.md', '.svg', '.txt', '.html', '.css'])

/** Every file below `dir` that is not inside a skipped directory. */
function walk (dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) found.push(...walk(join(dir, entry.name)))
      continue
    }
    if (entry.isFile() && TEXT.has(extname(entry.name).toLowerCase())) found.push(join(dir, entry.name))
  }
  return found
}

const problems = []
for (const file of walk(ROOT)) {
  const bytes = readFileSync(file)
  const name = relative(ROOT, file)
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    problems.push(`${name}: starts with a UTF-8 BOM`)
  }
  const crlf = bytes.indexOf(0x0d)
  if (crlf !== -1 && bytes[crlf + 1] === 0x0a) {
    const line = bytes.subarray(0, crlf).toString('latin1').split('\n').length
    problems.push(`${name}:${line}: CRLF line ending (this repository is LF-only)`)
  }
}

if (problems.length > 0) {
  console.error(`encoding check failed:\n${problems.map((problem) => `  ${problem}`).join('\n')}`)
  process.exit(1)
}
console.log('encoding check passed')
