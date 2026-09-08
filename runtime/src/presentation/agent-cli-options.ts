import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

export function agentCliOptions(cwd: string) {
  return {
    directory: { type: 'string', default: cwd }, name: { type: 'string' }, purpose: { type: 'string' },
    json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    destination: { type: 'string' }, resume: { type: 'boolean' },
    'personal-memory': { type: 'string' },
    'state-backend': { type: 'string' },
  } satisfies ParseArgsOptionsConfig;
}

export function agentTurnCliOptions(cwd: string) {
  return {
    directory: { type: 'string', default: cwd }, provider: { type: 'string' }, 'compact-provider': { type: 'string' },
    session: { type: 'string' }, 'new-session': { type: 'boolean', default: false }, conversation: { type: 'string', default: 'terminal' },
    'message-id': { type: 'string' }, text: { type: 'string' }, work: { type: 'string' }, 'goal-revision': { type: 'string' },
    'control-revision': { type: 'string' }, obligation: { type: 'string' },
    mode: { type: 'string' }, steps: { type: 'string' }, limit: { type: 'string' }, cursor: { type: 'string' },
    json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
  } satisfies ParseArgsOptionsConfig;
}

export function localCliOptions() {
  return {
    'data-dir': { type: 'string' }, directory: { type: 'string' }, 'state-backend': { type: 'string' }, conversation: { type: 'string', default: 'terminal' }, json: { type: 'boolean', default: false },
    session: { type: 'string' }, 'new-session': { type: 'boolean', default: false }, text: { type: 'string' }, limit: { type: 'string', default: '50' }, 'compact-provider': { type: 'string' },
    scenario: { type: 'string', default: 'documents-simple' }, 'request-id': { type: 'string' }, 'goal-revision': { type: 'string' }, 'control-revision': { type: 'string' },
    'memory-id': { type: 'string' }, 'memory-revision': { type: 'string' }, 'state-revision': { type: 'string' }, 'source-session': { type: 'string' },
    'source-message': { type: 'string' }, quote: { type: 'string' }, title: { type: 'string' }, query: { type: 'string' },
    'draft-id': { type: 'string' }, 'apply-id': { type: 'string' },
    mode: { type: 'string' }, reason: { type: 'string' }, level: { type: 'string' }, cursor: { type: 'string' },
    file: { type: 'string' }, 'resume-file': { type: 'string' }, obligation: { type: 'string' }, steps: { type: 'string', default: '40' }, 'analysis-only': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
  } satisfies ParseArgsOptionsConfig;
}

export function memoryMigrationCliOptions(cwd: string) {
  return {
    directory: { type: 'string', default: cwd }, from: { type: 'string' }, to: { type: 'string' },
    source: { type: 'string' }, target: { type: 'string' }, 'operation-id': { type: 'string' }, 'target-store-id': { type: 'string' },
    'backup-directory': { type: 'string' }, scope: { type: 'string' }, 'snapshot-digest': { type: 'string' },
    'offline-confirmed': { type: 'boolean' }, 'effects-reconciled': { type: 'boolean' },
    json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } satisfies ParseArgsOptionsConfig;
}

const chatCommands = ['session', 'ask', 'followup', 'goal', 'resume', 'pause', 'cancel', 'status', 'history'];
const workCommands = ['accept', 'demo', 'demo-plan', 'plan', 'run', 'status', 'work-view', 'pause', 'resume', 'cancel', 'mode',
  'change-goal', 'resolve', 'attach', 'disconnect', 'list', 'messages', 'events', 'checkpoint', 'session', 'history', 'input',
  'compact', 'context-status', 'memory-remember', 'memory-search', 'memory-get', 'memory-recall', 'memory-clear', 'memory-selected',
  'memory-revise', 'memory-forget', 'memory-draft-create', 'memory-draft-apply', 'memory-draft-resume', 'memory-draft-status'];

/** Selects only a CLI directory; the launcher must separately validate its host identity, pin and installed engine. */
export function agentLaunchDirectory(args: string[], cwd: string): string | null {
  try {
    // Match runAgentCli's first-token dispatch before parsing each route's options.
    if (args[0] === 'lifecycle') return null;
    if (args[0] === 'chat') {
      const { values, positionals } = parseArgs({ args: args.slice(1), allowPositionals: true, strict: true, options: agentTurnCliOptions(cwd) });
      if (values.help || positionals.length !== 1 || !chatCommands.includes(positionals[0]!)) return null;
      return values.directory;
    }
    if (args[0] === 'work') {
      const { values, positionals } = parseArgs({ args: args.slice(1), allowPositionals: true, strict: true, options: localCliOptions() });
      if (values.help || positionals.length < 1 || positionals.length > 2 || !workCommands.includes(positionals[0]!)) return null;
      if (values.directory !== undefined) return values.directory;
      // Preserve standalone options and let the original CLI report any agent-mode conflict.
      if (values['data-dir'] !== undefined || values['state-backend'] !== undefined) return null;
      return cwd;
    }
    if (args[0] === 'memory-migrate') {
      const { values, positionals } = parseArgs({ args: args.slice(1), allowPositionals: true, strict: true, options: memoryMigrationCliOptions(cwd) });
      if (values.help || positionals.length !== 1 || !['preview', 'apply', 'resume', 'status'].includes(positionals[0]!)) return null;
      return values.directory;
    }
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: agentCliOptions(cwd) });
    const command = positionals[0] ?? 'open';
    if (values.help || values.version || positionals.length > 1 || !['open', 'init', 'status'].includes(command)) return null;
    return values.directory;
  } catch {
    // Parsing failures retain the original CLI's error and output handling.
    return null;
  }
}
