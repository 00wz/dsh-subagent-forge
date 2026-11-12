# Subagent forge

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-green)](https://github.com/topics/dsh-plugin)

Replaces the built-in delegation tools with one configurable tool: the calling
agent writes the child's system prompt, optionally its first user message, picks
its model from a configurable allowlist (with descriptions the agent reads), sets
a reasoning effort, and decides whether that child may start subagents of its own.
The allowlist is seeded from the providers the profile configures, so it always
matches the installation.

```bash
# from a GitHub repository
dsh plugin --profile <profile> add "github:<owner>/dsh-subagent-forge"

# from a local checkout
dsh plugin --profile <profile> add /absolute/path/to/dsh-subagent-forge
```

Requires DeepSeek Harness `>=0.2.1` (`engines.dsh`). No build step: the package
ships plain ESM and declares no runtime dependencies or peer dependencies.

## Tools

Two symmetric tools replace the built-in pair:

| Tool | Provider | Child |
|---|---|---|
| `spawn_agent` | `spawn` | fresh session, gets your `system_prompt` |
| `fork_agent` | `fork` | seeded with this conversation's completed turns; inherits the system prompt and tool set, so it takes no `system_prompt` |

Shared parameters:

| Parameter | Meaning |
|---|---|
| `description` | short label, required |
| `prompt` | first user message / task; omitted uses `emptyPrompt` |
| `system_prompt` | only `spawn_agent`: durable role and rules for this child |
| `model_id` | one of the `model_id` values listed in the tool description (`provider/model`); pass the value verbatim, not its description. Omit to inherit the parent route |
| `reasoning_effort` | reasoning effort advertised for that model (`effort` is an alias) |
| `can_delegate` | **required**: whether the child may start its own subagents. Pass `true` when the task may need decomposition; pass `false` only for a terminal, single-shot task |
| `cwd` | initial child working directory |

`model` remains accepted as a deprecated alias of `model_id`, for prompts and
scripts written before the rename.

## Recursion

There is no depth counter. Delegation is gated per child by the `can_delegate`
flag the parent states on every call; a child that receives the grant decides
the same question for its own children. Children without the grant also lose
`workflow`, because it can start agents indirectly.

The flag bounds recursion; it is not a default to opt out of delegation. A task
that spans files, needs research, or would be split by the parent itself should
give the child the grant, and that child decides in turn whether to delegate.

The plugin hides the delegation tools from a child without the grant where the
runtime allows it, and refuses the call otherwise.

## Built-in delegation is blocked twice

1. `tools.guard` denies execution of `subagent` / `subagent_fork` in every
   scope, including steps whose tool list was resolved before this plugin
   loaded.
2. `tools.restrict` hides them from each agent's tool list, so the model does
   not see a tool it cannot use.

Both lists are configuration (`blockedTools`, `blockBuiltinDelegation`).

## Settings

The page lives in **Settings → Built-in plugins → Subagent forge** (a tab in the
Plugins settings section). It edits the model allowlist: one row per route with
the `description` the agent reads when it chooses.

On the first start the allowlist is seeded from the providers the profile
configures, so a fresh install can choose models immediately and never offers a
route the installation does not have. A model whose catalog entry has no
description is seeded with an empty one: the plugin does not substitute the
model name, so the settings page never shows an invented description. That
snapshot is persisted: edit it on the page, press **Add models from my
providers** to re-read the live catalog, or delete
`$DSH_HOME/subagent-forge/config.json` to seed again on the next start. A blank
row is dropped and a repeated route keeps its first row.

Edits are validated, applied to the live tool at once, and stored in
`$DSH_HOME/subagent-forge/config.json`, which takes precedence over the bundle
patch on the next start. A saved file always wins — including an empty list, which
is honoured as-is: the tool then only inherits the parent route. The write path is:

```
page → POST /subagent-forge/config (loopback only)
     → reconfigure(value): sanitize → file → re-register the tool
page → GET /subagent-forge/catalog
     → discoverModels(ctx): llm.listProviders → llm.listModels
```

The route is registered by the plugin itself through the optional `webServer`
service, so a headless profile keeps the tools and loses the page.

## Durability

Each child's spec is stored as JSON under
`$DSH_HOME/subagent-forge/children/<sessionId>.json` and re-applied when the
child resumes (the plugin re-registers the persona section and the restrictions
on `agent/created`, which fires for resumes too). Losing that directory does not
break a child; it only loses the custom persona on later resumes.

## Repository checks

```bash
npm run check   # encoding guard for shipped text files
npm test        # behaviour tests for the plugin
```

Both scripts use Node built-ins only; neither `test/` nor `scripts/` is part of
the published package.

## Known limits

- The child's composition (tool set) is inherited from the parent; only the
  persona and the delegation grant are overridden per child.
- `workflow` is not blocked for agents that hold the grant.
- The seeded allowlist is a snapshot of the providers registered at that moment;
  after changing the provider configuration, run the discovery again or delete
  `config.json`.
- Changing code of the installed package needs an application restart; the
  settings page itself needs one page refresh after installation.
- After installation the browser must be reloaded once to load the client half.
