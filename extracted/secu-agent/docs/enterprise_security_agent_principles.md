# Enterprise Security Agent Principles

## Mission

This project is an enterprise security autonomous agent, not a domain-specific
SMB or web scanner and not a narrow security-operations-only assistant. It should help with
threat tasking, ticket analysis, attack-surface review, vulnerability triage,
internal-information discovery, evidence packaging, and scheduled follow-up
work across authorized internal environments.

## Common Core

The operator core owns only cross-domain behavior:

- intent understanding and clarification
- plan, todo, approval, and busy-input state
- tool/skill/sub-agent routing from actual registries
- schedule and wakeup lifecycle
- context compression and memory
- semantic validation, evidence judgment, and report/finding contracts
- audit and delivery framing

Domain knowledge belongs outside the core. SMB, web, ticket, repository, CI,
cloud, endpoint, document, and log workflows should live in skills, sub-agents,
or domain prompts. A common prompt must not hard-code a single domain's API,
database shape, or preferred execution path.

## Design Comparison

| Area | Claude Code strong point | Hermes Agent strong point | This project decision |
|---|---|---|---|
| Tools | Self-contained tools with permission models and registry-driven prompts | Large pluggable toolsets and deferred capabilities | Use typed tools with `domain`, read/write/destructive metadata, prompt sections, and registry/list driven calls only. |
| Skills | Named reusable workflows and tool-context injection | Skill hub, skill usage, skill content in scheduled runs | Keep compact markdown skills, load on demand, and make domain runbooks explicit. Do not guess missing skill names. |
| Permissions | Permission modes, plan approval, IDE/UI approval paths | Approval buttons and active-session guard bypass for allow/deny/stop | Keep deterministic approval policy with `auto`, `manual`, `deny`, and `smart`; tool guards still execute after approval. |
| Autonomy | Scheduled tasks are session-aware and can be durable only when intended | Cron jobs, `wakeAgent` gate, disabled toolsets, inactivity timeout | Use schedule intent contracts, stale self-wakeup skip/queue decisions, dry-run delivery audit, explicit schedule-origin metadata, and schedule-origin tool guardrails. |
| GPT-OSS harness | State discipline around plan/todo/tool execution | Guardrails around cron, skills, and long-running activity | Prefer deterministic state machines and validators over prompt-only behavior. |

## GPT-OSS Harness Rule

Never use hidden watermarks, invisible markers, special secret tokens, or
watermark-like prompt tricks to control tool calling or judgment. GPT-OSS
alignment must come from visible contracts:

- schema validation
- tool registry and capability listings
- approval policy
- todo transition contract
- plan execution contract
- tool-loop guardrails
- semantic validation
- evidence judgment
- schedule intent contract
- tests and audit trails

If the model is unreliable, add or strengthen a deterministic harness instead
of adding hidden prompt markers.

## Agent Behavior

1. Start from the user's actual task, not from a domain assumption.
2. Load the common enterprise security policy when authorization, credentials,
   scheduling, or safety is relevant.
3. Load a domain skill only when the skill is registered and the task clearly
   matches it.
4. Use sub-agents only for context isolation or long bounded work, and only from
   `agent(action="list")`.
5. Do not report findings unless evidence contracts pass.
6. When blocked, report the gap and next concrete action. Do not fabricate
   skills, tools, agents, or findings.
7. Scheduled self-wakeups may continue autonomous work only when their source
   conversation has not been superseded.
8. Scheduled prompts must be marked as schedule-origin activity in transcript
   state and must not silently run destructive tools.
