import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cordis plugin name. */
export const name = 'subagent-forge'

/** Services this plugin requires. */
export const inject = ['tools', 'subagents', 'systemPrompt', 'agents']

/** Default user-editable configuration. */
const DEFAULTS = {
  toolName: 'spawn_agent',
  forkToolName: 'fork_agent',
  subagentProvider: 'spawn',
  forkProvider: 'fork',
  blockBuiltinDelegation: true,
  blockedTools: [],
  models: [],
  extraDelegationTools: ['workflow'],
  emptyPrompt: 'Begin the task described in your system prompt.',
}

/** The whole tool surface of `@deepseek-ai/dsh-tool-subagent`, replaced by this plugin. */
const REPLACED_TOOLS = ['subagent', 'subagent_fork', 'list_subagent_models']

const STRING_FIELDS = ['toolName', 'forkToolName', 'subagentProvider', 'forkProvider', 'emptyPrompt']
const NAME_LIST_FIELDS = ['blockedTools', 'extraDelegationTools']

/** Format a token count for a one-line model summary. */
function formatTokens (value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  if (value >= 1048576) return `${(value / 1048576).toFixed(1).replace(/\.0$/u, '')}M`
  if (value >= 1024) return `${Math.round(value / 1024)}k`
  return String(value)
}

/** One-line facts for a model the catalog does not describe. */
function modelFacts (model, info) {
  const modalities = Array.isArray(model?.inputModalities) && model.inputModalities.length > 0
    ? model.inputModalities
    : Array.isArray(info?.inputModalities) && info.inputModalities.length > 0 ? info.inputModalities : ['text']
  const parts = [modalities.includes('image') ? 'text+image' : 'text only']
  const context = formatTokens(info?.contextWindow ?? info?.context?.contextWindow ?? model?.contextWindow)
  const output = formatTokens(info?.maxTokens ?? info?.defaultMaxTokens ?? model?.maxTokens)
  if (context !== undefined) parts.push(`${context} context`)
  if (output !== undefined) parts.push(`${output} output`)
  return parts.join(' · ')
}

/** Keep only usable allowlist rows: a non-blank route, first occurrence wins. */
function normalizeModels (models) {
  const seen = new Set()
  const next = []
  for (const entry of Array.isArray(models) ? models : []) {
    const route = typeof entry?.route === 'string' ? entry.route.trim() : ''
    if (route.length === 0 || seen.has(route)) continue
    seen.add(route)
    next.push({ route, description: typeof entry?.description === 'string' ? entry.description : '' })
  }
  return next
}

/** Validate one raw configuration and fill its defaults; throws on a wrong shape. */
function sanitize (raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const value = {}
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    value[key] = source[key] === undefined ? (Array.isArray(fallback) ? [...fallback] : fallback) : source[key]
  }
  for (const key of STRING_FIELDS) {
    if (typeof value[key] !== 'string' || value[key].trim().length === 0) throw new Error(`\`${key}\` must be a non-empty string`)
  }
  if (typeof value.blockBuiltinDelegation !== 'boolean') throw new Error('`blockBuiltinDelegation` must be a boolean')
  for (const key of NAME_LIST_FIELDS) {
    if (!Array.isArray(value[key]) || value[key].some((name) => typeof name !== 'string')) {
      throw new Error(`\`${key}\` must be an array of tool names`)
    }
  }
  if (!Array.isArray(value.models)) throw new Error('`models` must be an array of { route, description }')
  value.models = normalizeModels(value.models)
  return value
}

const PERSONA_SECTION = 'deployment:persona-prefix'
const PERSONA_FALLBACK_SECTION = 'subagent-forge:persona'

/** Root data directory of this plugin. */
function dataDir () {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'subagent-forge')
}

/** Path of the user-edited configuration. */
function configPath () {
  return join(dataDir(), 'config.json')
}

/** Read the saved configuration, or undefined when none was saved yet. */
function readSavedConfig () {
  try {
    return sanitize(JSON.parse(readFileSync(configPath(), 'utf8')))
  } catch {
    return undefined
  }
}

/** Persist one validated configuration. */
function writeSavedConfig (value) {
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(configPath(), JSON.stringify(value, null, 2), 'utf8')
}

/** Read one persisted child spec, or undefined. */
function readSpec (childId) {
  try {
    return JSON.parse(readFileSync(join(dataDir(), 'children', `${childId}.json`), 'utf8'))
  } catch {
    return undefined
  }
}

/** Persist one child spec before the child is announced. */
function writeSpec (childId, spec) {
  const dir = join(dataDir(), 'children')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${childId}.json`), JSON.stringify(spec), 'utf8')
}

/**
 * Enumerate every route the live LLM runtime advertises.
 * @param ctx - context carrying the `llm` service.
 * @returns the advertised routes, or undefined when that service is unavailable.
 */
export async function discoverModels (ctx) {
  const llm = ctx.get('llm')
  if (llm === undefined) return undefined
  const found = []
  for (const provider of llm.listProviders()) {
    let models
    try {
      models = await llm.listModels(provider.id)
    } catch (error) {
      ctx.logger?.warn(`subagent-forge: cannot list the models of provider "${provider.id}": ${error?.message ?? error}`)
      continue
    }
    for (const model of Array.isArray(models) ? models : []) {
      if (typeof model?.id !== 'string' || model.id.trim().length === 0) continue
      let info
      try {
        info = await llm.resolveModelInfo(provider.id, model.id)
      } catch {
        // Facts are a convenience: a model that cannot be resolved still seeds its route.
        info = undefined
      }
      const declared = typeof model.description === 'string' ? model.description.trim() : ''
      found.push({
        route: `${provider.id}/${model.id}`,
        description: declared.length > 0 ? declared : modelFacts(model, info),
      })
    }
  }
  return normalizeModels(found)
}

/** How long the first start waits for providers to advertise models. */
const SEED_INTERVAL_MS = 250
const SEED_ATTEMPTS = 60

/**
 * Fill an empty allowlist from the live providers, retrying while the catalog is
 * still empty. A saved configuration always wins, so a deliberately emptied list
 * stays an inherit-only tool.
 * @param ctx - owning context.
 * @param attempt - retry counter.
 */
async function seedAllowlist (ctx, attempt = 0) {
  const local = state
  if (local === undefined || local.ctx !== ctx || local.config.models.length > 0) return
  if (readSavedConfig() !== undefined) return
  const models = await discoverModels(ctx)
  if (models === undefined || models.length === 0) {
    if (attempt >= SEED_ATTEMPTS) return
    const timer = setTimeout(() => { void seedAllowlist(ctx, attempt + 1) }, SEED_INTERVAL_MS)
    timer.unref?.()
    return
  }
  if (state !== local || local.config.models.length > 0 || readSavedConfig() !== undefined) return
  ctx.logger?.info(`subagent-forge: seeded the model allowlist with ${models.length} route(s) advertised by the live providers`)
  reconfigure({ ...local.config, models })
}

/** Split an allowlist route into provider and model, keeping slashes in the model id. */
function parseRoute (route) {
  const slash = route.indexOf('/')
  if (slash <= 0 || slash === route.length - 1) {
    throw new Error(`model route "${route}" must be "provider/model"`)
  }
  return { provider: route.slice(0, slash), model: route.slice(slash + 1) }
}

/** Render the allowlist for the model-facing description. */
function modelLines (config) {
  if (config.models.length === 0) return ['Allowed models: none configured yet; omit `model_id` to inherit your own route.']
  return [
    'Allowed models — pass one of these `model_id` values verbatim as `model_id` (the value, not its description):',
    ...config.models.map(entry => `- model_id: ${entry.route}${entry.description?.length > 0 ? `\n  description: ${entry.description}` : ''}`),
  ]
}

/** Build the model-facing description of one delegation tool. */
function toolDescription (config, inheritsContext) {
  const common = [
    'The child runs in a separate session; you receive its result, not its intermediate steps.',
    'A child can start its own subagents only when you pass `can_delegate: true`; a child that receives the grant decides the same question for its children. Pass `true` when the child’s task may need decomposition, and `false` only for a terminal, single-shot task that must be done alone.',
    'This tool replaces the built-in delegation tools; they are disabled.',
  ]
  const fresh = [
    'Start a subagent you configure completely: you write its system prompt, optionally its first user message, pick its `model_id` and reasoning effort from the allowed list, and decide whether it may start subagents of its own.',
    'The child starts fresh and does not see this conversation. Put durable role and rules into `system_prompt`, and the concrete task into `prompt`.',
  ]
  const fork = [
    'Start a subagent seeded with this conversation: it receives every completed turn so far, but not the current in-flight one, so build on that context instead of restating it.',
    'Its system prompt and tool set are inherited, so it takes no custom `system_prompt`; use it when the subtask needs this conversation’s context without spending this conversation’s context on the work.',
  ]
  const lines = inheritsContext
    ? [...fork, ...modelLines(config), ...common]
    : [...fresh, ...modelLines(config), ...common]
  return lines.join('\n')
}

/** Deny global tools inside one agent scope, tolerating names that scope does not have. */
function denyInScope (agent, names) {
  for (const name of names) {
    try {
      agent.ctx.tools.restrict({ deny: [name] })
    } catch {
      // A name this composition does not register cannot be restricted; the
      // global guard still blocks execution.
    }
  }
}

/** Give one child its own persona section, shadowing the inherited one when possible. */
function applyPersona (agent, text) {
  if (typeof text !== 'string' || text.trim().length === 0) return
  const prompt = agent.ctx.systemPrompt
  const order = prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX')
  try {
    prompt.section({ name: PERSONA_SECTION, order, text })
  } catch {
    prompt.section({ name: PERSONA_FALLBACK_SECTION, order: order + 0.5, text })
  }
}

/** Names of every tool that can start an agent in the configured composition. */
function delegationTools (config) {
  return [config.toolName, config.forkToolName, ...config.extraDelegationTools]
}

/** Built-in tools this plugin takes over, plus any deployment-specific extras. */
function effectiveBlockedTools (config) {
  if (!config.blockBuiltinDelegation) return []
  return [...new Set([...REPLACED_TOOLS, ...config.blockedTools])]
}

/** Hide built-in delegation and, when the child has no grant, every delegation tool. */
function hideDelegation (config, agent) {
  const blocked = effectiveBlockedTools(config)
  if (blocked.length > 0) denyInScope(agent, blocked)
  const spec = readSpec(agent.id)
  if (spec !== undefined && spec.canDelegate !== true) denyInScope(agent, delegationTools(config))
}

/** Resolve and preflight one model selection against the allowlist and the live adapter. */
async function resolveSelection (ctx, config, args, signal) {
  const requested = args.model_id ?? args.model
  const effort = args.reasoning_effort ?? args.effort
  if (effort !== undefined && requested === undefined) {
    throw new Error('`reasoning_effort` requires `model_id`; an inherited route keeps the parent effort')
  }
  if (requested === undefined) return undefined

  const wanted = String(requested)
  if (config.models.length === 0) {
    throw new Error('no models are allowed yet: add routes in Settings → Built-in plugins → Subagent forge, or omit `model_id` to inherit the parent route')
  }
  const entry = config.models.find(candidate => candidate.route === wanted)
  if (entry === undefined) {
    throw new Error(`model_id "${wanted}" is not allowed; allowed routes: ${config.models.map(candidate => candidate.route).join(', ')}`)
  }
  const route = parseRoute(entry.route)

  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('cannot resolve the selected model: the `llm` service is unavailable')
  await llm.resolveCallConfig({
    provider: route.provider,
    model: route.model,
    ...effort === undefined ? {} : { reasoningEffort: effort },
  }, signal)

  return { route, effort }
}

/** Tool parameters in the registry-ready spec shape, keyed by name. */
function parameterSpec (inheritsContext) {
  const spec = {
    description: {
      type: 'string',
      required: true,
      description: 'A short (3-5 word) label for the delegated task, for display.',
    },
    prompt: {
      type: 'string',
      description: inheritsContext
        ? 'The task for the child. It already sees the completed turns, so state only what is new.'
        : 'The first user message for the child. Omit to start it from the configured bootstrap text.',
    },
    model_id: {
      type: 'string',
      description: 'One of the `model_id` values listed under "Allowed models" — the exact string, not its description. Omit to inherit the parent route.',
    },
    model: {
      type: 'string',
      description: 'Deprecated alias of `model_id`; prefer `model_id`.',
    },
    reasoning_effort: {
      type: 'string',
      description: 'Reasoning effort id advertised for the chosen model. Requires `model_id`.',
    },
    effort: {
      type: 'string',
      description: 'Alias of `reasoning_effort`.',
    },
    can_delegate: {
      type: 'boolean',
      required: true,
      description: 'Whether this child may start its own subagents. Pass `true` when the task may need decomposition — research, multi-file work, anything you would split yourself; pass `false` only for a terminal, single-shot task that must be done alone. The flag bounds recursion; it is not a default to opt out of delegation.',
    },
    cwd: {
      type: 'string',
      description: 'Initial child working directory. Relative paths use your current directory; omitted inherits it.',
    },
  }
  if (!inheritsContext) {
    spec.system_prompt = {
      type: 'string',
      description: 'Durable role and rules for this child only. It replaces the inherited persona for that session; the parent keeps its own.',
    }
  }
  return spec
}

/** Convert a spec object into a JSON Schema the tool registry accepts. */
function toJsonSchema (spec) {
  const properties = {}
  const required = []
  for (const [key, field] of Object.entries(spec)) {
    const { required: isRequired, ...schema } = field
    properties[key] = schema
    if (isRequired === true) required.push(key)
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...required.length === 0 ? {} : { required },
  }
}

/** Build one delegation tool definition ready for `tools.register`. */
function buildTool (ctx, config, options) {
  const toolName = options.toolName
  const inheritsContext = options.inheritsContext

  return {
    name: toolName,
    description: toolDescription(config, inheritsContext),
    parameters: toJsonSchema(parameterSpec(inheritsContext)),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'activation' },
          subagentId: { type: 'string' },
        },
        required: ['kind', 'subagentId'],
      },
      render: (_args, value) => [{ type: 'text', text: `started subagent ${value.subagentId}` }],
    },
    isConcurrencySafe: () => true,
    async execute (args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error(`${toolName} requires a calling agent`)
      if (inheritsContext && args.system_prompt !== undefined) {
        throw new Error(`${toolName} inherits this conversation's system prompt and does not accept \`system_prompt\`; use ${config.toolName} for a child with its own prompt`)
      }

      const selection = await resolveSelection(ctx, config, args, exec.signal)
      exec.signal.throwIfAborted()

      const childId = randomUUID()
      writeSpec(childId, {
        systemPrompt: inheritsContext || typeof args.system_prompt !== 'string' ? '' : args.system_prompt,
        canDelegate: args.can_delegate === true,
        model: args.model_id ?? args.model ?? null,
        tool: toolName,
        createdAt: Date.now(),
      })

      const activation = await ctx.subagents.startActivation({
        provider: options.provider,
        childId,
        label: args.description,
        request: {
          parent,
          prompt: [{ type: 'text', text: args.prompt ?? config.emptyPrompt }],
          ...args.cwd === undefined ? {} : { cwd: args.cwd },
          ...selection === undefined ? {} : {
            agentOptions: {
              provider: selection.route.provider,
              model: selection.route.model,
              ...selection.effort === undefined ? {} : { reasoningEffort: selection.effort },
            },
          },
        },
        signal: exec.signal,
        delivery: 'parent',
      })

      return { kind: 'activation', subagentId: activation.childId }
    },
  }
}

/** Register both tools and the built-in block for one configuration. */
function mount (ctx, config) {
  const blocked = effectiveBlockedTools(config)
  const blockedSet = new Set(blocked)

  const disposeGuard = blocked.length === 0
    ? () => {}
    : ctx.tools.guard(execution => blockedSet.has(execution.name)
      ? `Blocked by ${name}: ${execution.name} is not available in this deployment; delegate with \`${config.toolName}\` or \`${config.forkToolName}\`, whose descriptions list the allowed routes.`
      : undefined)

  // Runs per execution and reads the durable spec, so a child started without
  // the grant cannot delegate even when the tool is still listed.
  const delegationNames = new Set(delegationTools(config))
  const disposeGrantGuard = ctx.tools.guard((execution) => {
    if (!delegationNames.has(execution.name)) return undefined
    const agent = execution.agent
    if (agent === undefined) return undefined
    const spec = readSpec(agent.id)
    if (spec === undefined || spec.canDelegate === true) return undefined
    return `Blocked by ${name}: this subagent was started without \`can_delegate\`, so it cannot delegate further.`
  })

  const disposers = [
    ctx.tools.register(buildTool(ctx, config, {
      toolName: config.toolName,
      provider: config.subagentProvider,
      inheritsContext: false,
    })),
    ctx.tools.register(buildTool(ctx, config, {
      toolName: config.forkToolName,
      provider: config.forkProvider,
      inheritsContext: true,
    })),
  ]

  return {
    dispose () {
      for (const dispose of disposers) dispose()
      disposeGrantGuard()
      disposeGuard()
    },
  }
}

/** Live plugin state, shared with the settings bridge in this package. */
let state

/** The configuration the tools currently run with. */
export function currentConfig () {
  return state?.config
}

/**
 * Replace the live configuration and persist it for the next start.
 * @param value - complete user configuration.
 * @returns the validated configuration now in effect.
 */
export function reconfigure (value) {
  const config = sanitize(value)
  writeSavedConfig(config)
  if (state !== undefined) {
    state.mounted.dispose()
    state.config = config
    state.mounted = mount(state.ctx, config)
    for (const agent of state.ctx.agents.list()) {
      try { hideDelegation(state.config, agent) } catch { /* agent leaving */ }
    }
  }
  return config
}

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
 * Expose the plugin configuration to its own settings page when the composition
 * has a web server.
 * @param ctx - owning context.
 */
function registerSettingsBridge (ctx) {
  ctx.inject(['webServer'], (scoped) => {
    const target = scoped ?? ctx
    const webServer = target.get('webServer') ?? target.webServer
    if (webServer === undefined || typeof webServer.register !== 'function') return
    target.effect(() => webServer.register({
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

        if (path === '/catalog' && req.method === 'GET') {
          const models = await discoverModels(target)
          if (models === undefined) return send(res, 503, { error: 'the `llm` service is unavailable' })
          return send(res, 200, { value: { models } })
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
  })
}

/**
 * Install the configurable delegation tools, make the built-in delegation tools
 * unreachable, and serve the settings page.
 * @param ctx - owning context.
 * @param baseConfig - configuration declared by the profile patch.
 */
export function apply (ctx, baseConfig) {
  const saved = readSavedConfig()
  const config = saved ?? sanitize(baseConfig)
  const local = { ctx, config, mounted: mount(ctx, config) }
  state = local

  ctx.effect(() => () => local.mounted.dispose())

  for (const agent of ctx.agents.list()) {
    try { hideDelegation(config, agent) } catch { /* an agent being torn down */ }
  }

  ctx.on('agent/created', ({ agent }) => {
    try {
      hideDelegation(state?.config ?? config, agent)
      const spec = readSpec(agent.id)
      if (spec !== undefined) applyPersona(agent, spec.systemPrompt)
    } catch (error) {
      ctx.logger.warn(`subagent-forge: child initialization failed for ${agent.id}: ${error}`)
    }
  })

  registerSettingsBridge(ctx)

  if (saved === undefined && config.models.length === 0) void seedAllowlist(ctx)
}
