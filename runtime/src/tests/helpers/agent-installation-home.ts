import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { isAbsolute } from 'node:path';

// Process-local test isolation for the CLI's default host registry. HOME is not changed.
const directory = process.env['SECUMON_INSTALLATION_HOME'];
if (!directory || !isAbsolute(directory)) throw new Error('installation_test_home_required');
os.homedir = () => directory;
syncBuiltinESMExports();
