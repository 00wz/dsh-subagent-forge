/**
 * Behaviour tests for dsh-subagent-forge.
 *
 * Loads the shipped `index.js` with a synthetic context and synthetic HTTP
 * requests; no staging, no peer stubs.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

const stage = mkdtempSync(join(tmpdir(), 'dsh-subagent-forge-'))
process.on('exit', () => rmSync(stage, { recursive: true, force: true }))
process.env.DSH_HOME = stage

const forge = await import(pathToFileURL(join(ROOT, 'index.js')).href)

const EXPECTED = [
  { route: 'polza/deepseek/x', description: 'fast' },
  { route: 'polza/z-ai/glm', description: 'GLM 5' },
  { route: 'local/llama', description: '' },
]

const fakeLlm = {
  listProviders: () => [{ id: 'polza', name: 'Polza' }, { id: 'local', name: 'Local' }],
  listModels: async (id) => {
    if (id === 'polza') {
      return [
        { id: 'deepseek/x', name: 'DeepSeek X', description: 'fast' },
        { id: 'z-ai/glm', name: 'GLM 5' },
      ]
    }
    if (id === 'local') return [{ id: 'llama' }]
    throw new Error(`unknown provider ${id}`)
  },
}

const tick = (ms = 100) => new Promise((done) => setTimeout(done, ms))
let passed = 0
const pass = (label) => {
  passed += 1
  console.log(`PASS ${label}`)
}

/** One scenario's own $DSH_HOME. */
function home (name) {
  const dir = join(stage, name)
  mkdirSync(dir, { recursive: true })
  process.env.DSH_HOME = dir
  return dir
}

/** Synthetic Cordis context: records registrations, serves web routes. */
function makeCtx ({ llm, withWebServer = true } = {}) {
  const registered = new Map()
  const guards = []
  const restrictions = []
  const routes = []
  const logs = []
  const ctx = {
    registered,
    guards,
    restrictions,
    routes,
    logs,
    tools: {
      register (tool) {
        registered.set(tool.name, tool)
        return () => registered.delete(tool.name)
      },
      guard (predicate) {
        guards.push(predicate)
        return () => guards.splice(guards.indexOf(predicate), 1)
      },
      restrict (spec) {
        restrictions.push(spec)
      },
    },
    agents: { list: () => [] },
    subagents: { startActivation: async () => ({ childId: 'child-1' }) },
    systemPrompt: { getSectionOrder: () => 1, section: () => {} },
    logger: {
      info: (message) => logs.push(`info: ${message}`),
      warn: (message) => logs.push(`warn: ${message}`),
    },
    effect (fn) {
      fn()
    },
    on () {},
    get (service) {
      if (service === 'llm') return llm
      if (service === 'webServer') return ctx.webServer
      return undefined
    },
    // Cordis runs the callback once every named service is present.
    inject (deps, callback) {
      if (deps.every((dependency) => ctx.get(dependency) !== undefined)) callback(ctx)
      return () => {}
    },
  }
  ctx.webServer = withWebServer
    ? {
        register (route) {
          routes.push(route)
          return () => {}
        },
      }
    : undefined
  return ctx
}

const baseConfig = () => ({ models: [] })

/** Drive one registered web route with a synthetic request/response pair. */
async function call (route, { host = '127.0.0.1:52856', method = 'GET', url = '/subagent-forge/config', body } = {}) {
  const req = new Readable({ read () {} })
  req.method = method
  req.url = url
  req.headers = { host }
  const chunks = []
  const res = {
    statusCode: 0,
    writeHead (status) {
      this.statusCode = status
    },
    end (text) {
      chunks.push(text ?? '')
    },
  }
  const pending = route.handler(req, res)
  if (body !== undefined) req.push(JSON.stringify(body))
  req.push(null)
  await pending
  return { status: res.statusCode, body: chunks.length === 0 ? null : JSON.parse(chunks.join('')) }
}

// --- A: the shipped module imports no Harness package -----------------------
{
  const source = readFileSync(join(ROOT, 'index.js'), 'utf8')
  assert.doesNotMatch(source, /from\s+['"]@deepseek-ai\//u, 'no @deepseek-ai import can be resolved from a profile install')
  assert.doesNotMatch(source, /\bdefineTool\s*\(\s*\{/u, 'tools are registered as plain registry-ready objects')
  pass('the plugin imports no Harness package')
}

// --- B: first start seeds the allowlist from the live providers -------------
{
  const dir = home('seed')
  const ctx = makeCtx({ llm: fakeLlm })
  forge.apply(ctx, baseConfig())
  await tick()

  const saved = JSON.parse(readFileSync(join(dir, 'subagent-forge', 'config.json'), 'utf8'))
  assert.deepEqual(saved.models, EXPECTED, 'the seeded allowlist matches the live catalog')

  const spawn = ctx.registered.get('spawn_agent')
  const fork = ctx.registered.get('fork_agent')
  assert.ok(spawn, 'spawn_agent is registered')
  assert.ok(fork, 'fork_agent is registered')
  assert.equal(spawn.parameters.type, 'object', 'parameters are JSON Schema')
  assert.deepEqual(spawn.parameters.required, ['description', 'can_delegate'], 'required parameters are a JSON Schema list')
  assert.ok(spawn.parameters.properties.system_prompt, 'spawn_agent takes a system prompt')
  assert.equal(fork.parameters.properties.system_prompt, undefined, 'fork_agent takes no system prompt')
  assert.match(spawn.description, /Allowed models:/u, 'the allowlist reaches the model')
  assert.match(spawn.description, /polza\/deepseek\/x — fast/u, 'the route description reaches the model')
  assert.doesNotMatch(spawn.description, /none configured yet/u)
  assert.match(fork.description, /polza\/z-ai\/glm/u)
  assert.equal(ctx.guards.length, 2, 'the built-in block and the grant guard are installed')
  pass('first start seeds the allowlist from the live providers')
}

// --- B2: the seeded file survives a restart and is not overwritten ----------
{
  home('seed')
  const emptyLlm = { listProviders: () => [], listModels: async () => [] }
  const ctx = makeCtx({ llm: emptyLlm })
  forge.apply(ctx, baseConfig())
  await tick()

  const saved = JSON.parse(readFileSync(join(process.env.DSH_HOME, 'subagent-forge', 'config.json'), 'utf8'))
  assert.deepEqual(saved.models, EXPECTED, 'the saved allowlist is reused as-is')
  assert.match(ctx.registered.get('spawn_agent').description, /polza\/deepseek\/x/u)
  pass('a saved allowlist wins on the next start')
}

// --- C: a user-saved allowlist is never replaced by seeding -----------------
{
  const dir = home('saved')
  mkdirSync(join(dir, 'subagent-forge'), { recursive: true })
  const file = join(dir, 'subagent-forge', 'config.json')
  const text = JSON.stringify({ models: [{ route: 'polza/only', description: 'saved' }] }, null, 2)
  writeFileSync(file, text, 'utf8')

  const ctx = makeCtx({ llm: fakeLlm })
  forge.apply(ctx, baseConfig())
  await tick()

  assert.equal(readFileSync(file, 'utf8'), text, 'the saved file is untouched')
  assert.match(ctx.registered.get('spawn_agent').description, /polza\/only — saved/u)
  assert.doesNotMatch(ctx.registered.get('spawn_agent').description, /polza\/deepseek\/x/u)
  pass('a saved configuration is not overwritten')
}

// --- D: no LLM service leaves an inherit-only tool -------------------------
{
  const dir = home('bare')
  const ctx = makeCtx({})
  forge.apply(ctx, baseConfig())
  await tick(400)

  assert.equal(existsSync(join(dir, 'subagent-forge', 'config.json')), false, 'nothing is written without a catalog')
  const spawn = ctx.registered.get('spawn_agent')
  assert.match(spawn.description, /none configured yet/u)
  await assert.rejects(
    () => spawn.execute(
      { description: 'x', model: 'polza/deepseek/x', can_delegate: true },
      { agent: {}, signal: { throwIfAborted () {} } },
    ),
    /no models are allowed yet/u,
    'choosing a model without an allowlist fails with the guidance',
  )
  pass('without providers the allowlist stays empty and the tool explains itself')
}

// --- E: one row serves both the settings config and the catalog ------------
{
  home('bridge')
  const ctx = makeCtx({ llm: fakeLlm })
  forge.apply(ctx, baseConfig())
  await tick()
  assert.equal(ctx.routes.length, 1, 'the plugin registers one prefix route without a second row')
  const route = ctx.routes[0]

  const catalog = await call(route, { url: '/subagent-forge/catalog' })
  assert.equal(catalog.status, 200)
  assert.deepEqual(catalog.body.value.models, EXPECTED)

  const forbidden = await call(route, { url: '/subagent-forge/catalog', host: 'evil.example' })
  assert.equal(forbidden.status, 403, 'a non-loopback Host header is rejected')

  const posted = await call(route, {
    method: 'POST',
    body: {
      value: {
        models: [
          { route: '  ', description: 'blank row' },
          { route: ' polza/deepseek/x ', description: 'edited' },
          { route: 'polza/deepseek/x', description: 'duplicate' },
        ],
      },
    },
  })
  assert.equal(posted.status, 200)
  assert.deepEqual(posted.body.value.models, [{ route: 'polza/deepseek/x', description: 'edited' }], 'blank and duplicate rows are dropped')

  const readBack = await call(route, { url: '/subagent-forge/config' })
  assert.deepEqual(readBack.body.value.models, [{ route: 'polza/deepseek/x', description: 'edited' }], 'the normalized value is persisted')
  assert.match(ctx.registered.get('spawn_agent').description, /polza\/deepseek\/x — edited/u, 'the live tool follows the saved value')
  pass('one row serves /config and /catalog')
}

// --- F: a headless composition without a web server still mounts -----------
{
  home('headless')
  const ctx = makeCtx({ llm: fakeLlm, withWebServer: false })
  forge.apply(ctx, baseConfig())
  await tick()
  assert.equal(ctx.routes.length, 0)
  assert.ok(ctx.registered.get('spawn_agent'), 'the delegation tools still mount')
  pass('a profile without a web server still gets the tools')
}

// --- G: the bridge reports a missing LLM service ---------------------------
{
  home('bridge-bare')
  const ctx = makeCtx({})
  forge.apply(ctx, baseConfig())
  await tick()
  const catalog = await call(ctx.routes[0], { url: '/subagent-forge/catalog' })
  assert.equal(catalog.status, 503)
  assert.match(catalog.body.error, /llm/u)
  pass('the catalog route degrades to 503 without the llm service')
}

// --- G2: a child without the grant cannot delegate ------------------------
{
  const dir = home('grant')
  const ctx = makeCtx({ llm: fakeLlm })
  forge.apply(ctx, baseConfig())
  await tick()

  const grantGuard = ctx.guards.at(-1)
  assert.equal(typeof grantGuard, 'function', 'the grant guard is installed')
  const children = join(dir, 'subagent-forge', 'children')
  mkdirSync(children, { recursive: true })
  const spec = join(children, 'child-plain.json')
  writeFileSync(spec, JSON.stringify({ canDelegate: false }), 'utf8')

  assert.match(grantGuard({ name: 'spawn_agent', agent: { id: 'child-plain' } }), /cannot delegate/u, 'a gated child is denied')
  assert.match(grantGuard({ name: 'workflow', agent: { id: 'child-plain' } }), /cannot delegate/u, 'workflow is denied too')
  assert.equal(grantGuard({ name: 'read', agent: { id: 'child-plain' } }), undefined, 'ordinary tools stay available')
  assert.equal(grantGuard({ name: 'spawn_agent', agent: { id: 'parent' } }), undefined, 'the parent is never gated')

  writeFileSync(spec, JSON.stringify({ canDelegate: true }), 'utf8')
  assert.equal(grantGuard({ name: 'spawn_agent', agent: { id: 'child-plain' } }), undefined, 'a granted child may delegate')
  pass('a child without the grant is blocked at execution time')
}

// --- G3: first start waits for providers that register late ---------------
{
  const dir = home('late')
  const started = Date.now()
  const lateLlm = {
    listProviders: () => Date.now() - started > 400 ? [{ id: 'polza', name: 'Polza' }] : [],
    listModels: async () => [{ id: 'late/model', name: 'Late model' }],
  }
  const ctx = makeCtx({ llm: lateLlm })
  forge.apply(ctx, baseConfig())
  await tick(100)
  assert.equal(existsSync(join(dir, 'subagent-forge', 'config.json')), false, 'nothing is written while the catalog is empty')
  await tick(900)
  const saved = JSON.parse(readFileSync(join(dir, 'subagent-forge', 'config.json'), 'utf8'))
  assert.deepEqual(saved.models, [{ route: 'polza/late/model', description: 'Late model' }], 'the retry seeds once providers appear')
  pass('first start retries until providers advertise models')
}

// --- H: the client bundle registers under the package name ----------------
{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const client = readFileSync(join(ROOT, 'client.js'), 'utf8')
  const start = client.indexOf('__ModuleLoader__.load(')
  assert.ok(start >= 0, 'the client bundle uses the module loader')
  const moduleId = client.slice(start).match(/\bid:\s*'([^']+)'/u)?.[1]
  assert.equal(moduleId, pkg.name, 'the Host lists the bundle by package name, so the registration id must match it')
  pass('the client bundle registers under the package name')
}

console.log(`\n${passed} checks passed`)
