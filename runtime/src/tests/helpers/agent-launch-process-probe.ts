import { executeSelectedAgentEngine } from '../../presentation/agent-engine-launcher.js';
const [directory, ...args] = process.argv.slice(2);
if (!directory) throw new Error('fixture_engine_required');
process.exitCode = await executeSelectedAgentEngine(args, directory);
