import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ArtifactRef, WorkState } from '../../domain/model.js';
import type { SessionPage } from '../../domain/session.js';

export interface InstallationSnapshot {
  state: WorkState;
  history: SessionPage;
  artifacts: { ref: ArtifactRef; sha256: string }[];
}

const [engineInput, mode, directory, workId, sessionId] = process.argv.slice(2);
assert.ok(engineInput && directory);
const engine = realpathSync(engineInput);
const moduleUrl = (path: string) => pathToFileURL(join(engine, 'dist', path)).href;

// Dynamic imports must come from the installed tree; source-repository imports above are types only.
if (mode === 'assets') {
  const { FileGuidanceSource } = await import(moduleUrl('infrastructure/file-guidance.js')) as typeof import('../../infrastructure/file-guidance.js');
  const guidance = new FileGuidanceSource(join(engine, 'guidance'));
  const manifests = await guidance.list();
  assert.ok(manifests.length > 0);
  for (const manifest of manifests) {
    const body = await guidance.read(manifest.id, manifest.version);
    assert.equal(body.byteLength, manifest.byteLength);
    assert.equal(createHash('sha256').update(body).digest('hex'), manifest.sha256);
    assert.equal(await guidance.validate(manifest), true);
  }
  const { openAgentWeb } = await import(moduleUrl('presentation/agent-web.js')) as typeof import('../../presentation/agent-web.js');
  const web = await openAgentWeb(['--directory', directory, '--provider', 'synthetic', '--port', '0', '--conversation', 'installation-assets']);
  assert.ok(web);
  const assets = [
    ['/', 'src/presentation/web/index.html', 'text/html'],
    ['/assets/styles.css', 'src/presentation/web/styles.css', 'text/css'],
    ['/assets/client.js', 'dist/presentation/web/client.js', 'text/javascript'],
    ['/assets/view-state.js', 'dist/presentation/web/view-state.js', 'text/javascript'],
    ['/assets/personal-memory.js', 'dist/presentation/web/personal-memory.js', 'text/javascript'],
  ] as const;
  try {
    assert.equal(new URL(web.server.origin).hostname, '127.0.0.1');
    for (const [route, path, contentType] of assets) {
      const response: Response = await fetch(new URL(route, web.server.origin), { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200, route);
      assert.ok(response.headers.get('content-type')?.startsWith(contentType), route);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(join(engine, path)), path);
    }
  } finally { await web.close(); }
  process.stdout.write(JSON.stringify({ assets: assets.map(([route]) => route), guidance: manifests.map(item => item.id) }) + '\n');
} else if (mode === 'snapshot') {
  assert.ok(workId && sessionId);
  const { openAgentTurnProfile } = await import(moduleUrl('presentation/agent-turn-profile.js')) as typeof import('../../presentation/agent-turn-profile.js');
  const profile = await openAgentTurnProfile(directory, { provider: 'synthetic' });
  try {
    const state = await profile.services.state.get(workId);
    assert.ok(state);
    const artifacts: InstallationSnapshot['artifacts'] = [];
    const refs = new Map<string, ArtifactRef>();
    for (const ref of state.artifacts) refs.set(ref.id, ref);
    for (const call of state.modelCalls) {
      refs.set(call.inputArtifact.id, call.inputArtifact);
      if (call.replyArtifact) refs.set(call.replyArtifact.id, call.replyArtifact);
    }
    for (const ref of refs.values()) {
      const bytes = await profile.services.artifacts.get(ref, profile.policy);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      assert.equal(sha256, ref.sha256);
      artifacts.push({ ref, sha256 });
    }
    const snapshot: InstallationSnapshot = { state, artifacts,
      history: await profile.sessions.history(profile.actor, sessionId, profile.policy, { limit: 100 }) };
    process.stdout.write(JSON.stringify(snapshot) + '\n');
  } finally { await profile.close(); }
} else throw new Error('installation_probe_mode_invalid');
