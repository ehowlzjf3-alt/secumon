import { runAgentCli, reportAgentCliFailure } from '../../presentation/agent-cli.js';

const registry = process.env['SECUMON_TEST_IDENTITY_REGISTRY'];
if (!registry) throw new Error('test_identity_registry_required');
try { await runAgentCli(process.argv.slice(2), { identityRegistryDirectory: registry }); }
catch (error) {
  if (process.env['SECUMON_TEST_CLI_DEBUG_ERRORS'] === '1') console.error(error);
  reportAgentCliFailure(error);
}
