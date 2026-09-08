import { runAgentCli } from '../../presentation/agent-cli.js';
import { reportAgentMissionCliFailure } from '../../presentation/agent-mission-cli.js';
import { residentControlEntryHost } from '../resident-control-entry-host.js';

const registry = process.env['SECUMON_RESIDENT_CLI_REGISTRY'];
if (!registry) throw new Error('resident_cli_test_registry_required');
const entry = residentControlEntryHost(registry, process.env['SECUMON_RESIDENT_CLI_NO_MISSIONS'] !== '1');
try { await runAgentCli(process.argv.slice(2), entry.host); }
catch (error) { reportAgentMissionCliFailure(error, process.argv.includes('--json')); }
finally { entry.assertIdleAndClosed(); }
