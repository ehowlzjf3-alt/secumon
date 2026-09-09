const { execFileSync } = require('node:child_process');
process.stdout.write(execFileSync(process.execPath, ['/home/shaneee/secumon-c10-403.A0DpgL/native-probe.cjs'], {
  env: {}, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
}));
