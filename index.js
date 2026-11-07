import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'subagent-forge'

/** Services this plugin requires. */
export const inject = ['tools', 'subagents', 'systemPrompt', 'agents']

/**
 * User-editable configuration. The settings page edits the same fields and
 * stores them beside the child specs, so an edit survives a restart.
 */
export const Config = z.object({
  toolName: z.string().default('spawn_agent'),
  forkToolName: z.string().default('fork_agent'),
  subagentProvider: z.string().default('spawn'),
  forkProvider: z.string().default('fork'),
  blockBuiltinDelegation: z.boolean().default(true),
  blockedTools: z.array(z.string()).default(['subagent', 'subagent_fork']),
  models: z.array(z.object({
    route: z.string().required(),
    description: z.string().default(''),
  })).default([]),
  extraDelegationTools: z.array(z.string()).default(['workflow']),
  emptyPrompt: z.string().default('Begin the task described in your system prompt.'),
})

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

/** Drop fields this version no longer declares, then validate and fill defaults. */
function sanitize (raw) {
  const defaults = Config({})
  const next = { ...defaults }
  for (const key of Object.keys(defaults)) {
    if (raw?.[key] !== undefined) next[key] = raw[key]
  }
  return Config(next)
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
  if (config.models.length === 0) return ['Allowed models: none configured yet; only the current route can be used.']
  return ['Allowed models:', ...config.models.map(entry =>
    `- ${entry.route}${entry.description?.length > 0 ? ` — ${entry.description}` : ''}`)]
}

/** Build the model-facing description of one delegation tool. */
function toolDescription (config, inheritsContext) {
  const common = [
    'The child runs in a separate session; you receive its result, not its intermediate steps.',
    'A child can start its own subagents only when you pass `can_delegate: true`. There is no depth limit: a child that receives the grant decides the same question for its own children. Grant it only when the task genuinely needs further decomposition.',
    'This tool replaces the built-in delegation tools; they are disabled.',
  ]
  const fresh = [
    'Start a subagent you configure completely: you write its system prompt, optionally its first user message, pick its model and reasoning effort from the allowed list, and decide whether it may start subagents of its own.',
    'The child starts fresh and does not see this conversation. Put durable role and rules into `system_prompt`, and the concrete task into `prompt`.',
  ]
  const fork = [
    'Start a subagent seeded with this conversation: it receives every completed turn so far, but not the current in-flight one, so build on that context instead of restating it.',
    'Its system prompt and tool set are inherited, so it takes no custom `system_prompt`; use it when the subtask needs this conversation’s context without spending this conversation’s context on the work.',
  ]
  const lines = inheritsContext ? [...fork, ...common] : [...fresh, ...common]
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

/** Hide built-in delegation and, when the child has no grant, every delegation tool. */
function hideDelegation (config, agent) {
  if (config.blockBuiltinDelegation) denyInScope(agent, config.blockedTools)
  const spec = readSpec(agent.id)
  if (spec !== undefined && spec.canDelegate !== true) denyInScope(agent, delegationTools(config))
}

/** Resolve and preflight one model selection against the allowlist and the live adapter. */
async function resolveSelection (ctx, config, args, signal) {
  const effort = args.reasoning_effort ?? args.effort
  if (effort !== undefined && args.model === undefined) {
    throw new Error('`reasoning_effort` requires `model`; an inherited route keeps the parent effort')
  }
  if (args.model === undefined) return undefined

  const wanted = String(args.model)
  if (config.models.length === 0) {
    throw new Error('no models are allowed yet: configure the model allowlist before choosing a route')
  }
  const entry = config.models.find(candidate => candidate.route === wanted)
  if (entry === undefined) {
    throw new Error(`model route "${wanted}" is not allowed; allowed routes: ${config.models.map(candidate => candidate.route).join(', ')}`)
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

/** Build one delegation tool definition. */
function buildTool (ctx, config, options) {
  const toolName = options.toolName
  const inheritsContext = options.inheritsContext

  const parameters = {
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
    model: {
      type: 'string',
      description: 'Exactly one route from the allowed list, written as "provider/model". Omit to inherit the parent route.',
    },
    reasoning_effort: {
      type: 'string',
      description: 'Reasoning effort id advertised for the chosen model. Requires `model`.',
    },
    effort: {
      type: 'string',
      description: 'Alias of `reasoning_effort`.',
    },
    can_delegate: {
      type: 'boolean',
      required: true,
      description: 'Whether this child may start its own subagents. State it on every call: a child that receives the grant decides the same question for its children.',
    },
    cwd: {
      type: 'string',
      description: 'Initial child working directory. Relative paths use your current directory; omitted inherits it.',
    },
  }

  if (!inheritsContext) {
    parameters.system_prompt = {
      type: 'string',
      description: 'Durable role and rules for this child only. It replaces the inherited persona for that session; the parent keeps its own.',
    }
  }

  return defineTool({
    name: toolName,
    description: toolDescription(config, inheritsContext),
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'activation' },
          subagentId: { type: 'string', required: true },
        },
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
        model: args.model ?? null,
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
  })
}

/** Register both tools and the built-in block for one configuration. */
function mount (ctx, config) {
  const blocked = config.blockBuiltinDelegation ? [...config.blockedTools] : []
  const blockedSet = new Set(blocked)

  const disposeGuard = blocked.length === 0
    ? () => {}
    : ctx.tools.guard(execution => blockedSet.has(execution.name)
      ? `Blocked by ${name}: start subagents with \`${config.toolName}\` or \`${config.forkToolName}\` instead.`
      : undefined)

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

/**
 * Install the configurable delegation tools and make the built-in delegation
 * tools unreachable.
 * @param ctx - owning context.
 * @param baseConfig - configuration declared by the profile patch.
 */
export function apply (ctx, baseConfig) {
  const config = readSavedConfig() ?? sanitize(baseConfig)
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
}
