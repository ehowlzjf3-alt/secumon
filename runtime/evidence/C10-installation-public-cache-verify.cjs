const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const cacheRoot = process.argv[2], npmCli = process.argv[3], lockPath = process.argv[4];
const cache = createRequire(npmCli)('cacache'), ssri = createRequire(npmCli)('ssri');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
(async () => {
  const manifestBytes = readFileSync(join(cacheRoot, 'public-cache-manifest.json'));
  assert.equal(sha256(manifestBytes), 'ab7c6d11de2a26fccd25843bff62ba84e844ef3db595b3ed8117c24920293e79');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const lockBytes = readFileSync(lockPath), lock = JSON.parse(lockBytes.toString('utf8'));
  assert.equal(sha256(lockBytes), manifest.packageLockSha256);
  const production = Object.entries(lock.packages).filter(([path, value]) => path && !value.dev);
  assert.equal(production.length, 18);
  const cachePath = join(cacheRoot, '_cacache'), listing = await cache.ls(cachePath);
  assert.equal(Object.keys(listing).length, 36);
  const confirmed = [];
  for (const entry of manifest.records) {
    const info = await cache.get.info(cachePath, entry.key), content = await cache.get(cachePath, entry.key);
    assert.ok(info); assert.equal(content.integrity, entry.integrity);
    assert.equal(sha256(content.data), entry.sha256); assert.equal(content.data.length, entry.bytes);
    assert.ok(ssri.checkData(content.data, entry.integrity));
    assert.equal(sha256(JSON.stringify(info.metadata)), entry.metadataSha256);
    assert.equal(info.metadata.url, entry.url);
    assert.ok(Object.keys(info.metadata).every(key => ['url', 'time', 'reqHeaders', 'resHeaders', 'options'].includes(key)));
    assert.ok(Object.keys(info.metadata.reqHeaders).every(key => manifest.requestHeaderAllowlist.includes(key)));
    assert.ok(Object.keys(info.metadata.resHeaders).every(key => manifest.responseHeaderAllowlist.includes(key)));
    assert.ok(Object.keys(info.metadata.options).every(key => key === 'compress'));
    const selected = lock.packages[`node_modules/${entry.name}`];
    assert.ok(selected && !selected.dev); assert.equal(entry.version, selected.version);
    if (entry.kind === 'tarball') { assert.equal(entry.integrity, selected.integrity); assert.equal(entry.url, selected.resolved); }
    else {
      const body = JSON.parse(content.data.toString('utf8'));
      assert.equal(body.versions[selected.version].dist.integrity, selected.integrity);
      assert.equal(body.versions[selected.version].dist.tarball, selected.resolved);
    }
    confirmed.push(`${entry.name}:${entry.kind}`);
  }
  for (const [path] of production) {
    const name = path.slice('node_modules/'.length);
    assert.ok(confirmed.includes(`${name}:tarball`)); assert.ok(confirmed.includes(`${name}:manifest`));
  }
  process.stdout.write(JSON.stringify({ checkpoint: 403, cacheRoot, platform: process.platform, node: process.version,
    productionPackages: 18, tarballs: 18, manifests: 18, entries: 36,
    integrityVerified: true, sourceLockMatches: true, sanitizedMetadataVerified: true,
    packageLockSha256: manifest.packageLockSha256, manifestSha256: sha256(manifestBytes),
    cacheMutation: false, networkRequests: 0, installationTestsRun: false }, null, 2) + '\n');
})().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
