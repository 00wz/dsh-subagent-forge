# Subagent forge

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-green)](https://github.com/topics/dsh-plugin)

Replaces the built-in delegation tools with one configurable tool: the calling
agent writes the child's system prompt, optionally its first user message, picks
its model from a configurable allowlist (with descriptions the agent reads), sets
a reasoning effort, and decides whether that child may start subagents of its own.

```bash
# from a GitHub repository
dsh plugin --profile <profile> add "github:<owner>/dsh-subagent-forge"

# from a local checkout
dsh plugin --profile <profile> add /absolute/path/to/dsh-subagent-forge
```

Requires DeepSeek Harness `>=0.2.1` (`engines.dsh`). No build step: the package
ships plain ESM.

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
| `model` | `provider/model`, exactly one allowlist route |
| `reasoning_effort` | reasoning effort advertised for that model (`effort` is an alias) |
| `can_delegate` | **required**: whether the child may start its own subagents |
| `cwd` | initial child working directory |

## Recursion

There is no depth counter. A child sees the delegation tools only when its
direct parent passed `can_delegate: true`; a child that receives the grant
decides the same question for its own children. Children without the grant also
lose `workflow`, because it can start agents indirectly.

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

Edits are validated, applied to the live tool at once, and stored in
`$DSH_HOME/subagent-forge/config.json`, which takes precedence over the bundle
patch on the next start. The write path is:

```
page → POST /subagent-forge/config (loopback only)
     → reconfigure(value): Config(value) → file → re-register the tool
```

The route is registered by the second bundle row (`subagent-forge-bridge`).

## Durability

Each child's spec is stored as JSON under
`$DSH_HOME/subagent-forge/children/<sessionId>.json` and re-applied when the
child resumes (the plugin re-registers the persona section and the restrictions
on `agent/created`, which fires for resumes too). Losing that directory does not
break a child; it only loses the custom persona on later resumes.

## Known limits

- The child's composition (tool set) is inherited from the parent; only the
  persona and the delegation grant are overridden per child.
- `workflow` is not blocked for agents that hold the grant.
- Changing code of the installed package needs an application restart; the
  settings page itself needs one page refresh after installation.
- After installation the browser must be reloaded once to load the client half.
