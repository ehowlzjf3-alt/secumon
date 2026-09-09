const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { homedir, tmpdir } = require('node:os');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const npmCli = process.argv[2];
const lockPath = process.argv[3];
const destination = process.argv[4] || mkdtempSync(join(tmpdir(), 'secumon-c10-npm-403.'));
const requestHeaders = ['accept-charset', 'accept-encoding', 'accept-language', 'accept', 'cache-control'];
const responseHeaders = ['cache-control', 'content-encoding', 'content-language', 'content-type', 'date', 'etag', 'expires', 'last-modified', 'pragma', 'vary'];
const cache = createRequire(npmCli)('cacache');
const ssri = createRequire(npmCli)('ssri');
const sha256 = data => createHash('sha256').update(data).digest('hex');
function publicUrl(value) {
  const url = new URL(value);
  assert.equal(url.protocol, 'https:'); assert.equal(url.hostname, 'registry.npmjs.org');
  assert.equal(url.port, ''); assert.equal(url.username, ''); assert.equal(url.password, '');
  assert.equal(url.search, ''); assert.equal(url.hash, '');
  return value;
}
function headers(input, allowed) {
  const selected = {};
  for (const name of allowed) if (typeof input?.[name] === 'string') selected[name] = input[name];
  return selected;
}
function metadata(input, url) {
  const result = { url, reqHeaders: headers(input?.reqHeaders, requestHeaders), resHeaders: headers(input?.resHeaders, responseHeaders), options: {} };
  if (typeof input?.time === 'number' && Number.isFinite(input.time)) result.time = input.time;
  if (typeof input?.options?.compress === 'boolean') result.options.compress = input.options.compress;
  if (input?.status !== undefined) assert.ok(input.status === 200 || input.status === 304);
  if (result.resHeaders.vary) {
    const names = result.resHeaders.vary.toLowerCase().split(',').map(name => name.trim());
    assert.ok(names.every(name => requestHeaders.includes(name)), 'Only public ordinary vary headers may be transferred');
  }
  return result;
}
(async () => {
  const lockBytes = readFileSync(lockPath), lock = JSON.parse(lockBytes.toString('utf8'));
  const source = join(homedir(), '.npm', '_cacache');
  const records = [];
  let packageCount = 0, tarballCount = 0, manifestCount = 0;
  for (const [path, item] of Object.entries(lock.packages)) {
    if (!path || item.dev) continue;
    assert.ok(path.startsWith('node_modules/') && item.resolved && item.integrity);
    const name = path.slice('node_modules/'.length);
    const manifestUrls = [...new Set([name, name.replace('/', '%2f'), name.replace('/', '%2F')].map(value => `https://registry.npmjs.org/${value}`))];
    let manifests = 0;
    for (const url of [...manifestUrls, item.resolved]) {
      publicUrl(url);
      const key = `make-fetch-happen:request-cache:${url}`, info = await cache.get.info(source, key);
      if (!info && url !== item.resolved) continue;
      assert.ok(info, `Missing locked public cache entry for ${name}`);
      const entry = await cache.get(source, key);
      assert.equal(entry.integrity, info.integrity);
      assert.ok(ssri.checkData(entry.data, info.integrity));
      const kind = url === item.resolved ? 'tarball' : 'manifest';
      if (kind === 'tarball') { assert.equal(entry.integrity, item.integrity); tarballCount++; }
      else {
        const body = JSON.parse(entry.data.toString('utf8'));
        assert.equal(body.name, name);
        assert.equal(body.versions?.[item.version]?.dist?.integrity, item.integrity);
        assert.equal(body.versions?.[item.version]?.dist?.tarball, item.resolved);
        manifests++; manifestCount++;
      }
      const safeMetadata = metadata(info.metadata, url);
      await cache.put(join(destination, '_cacache'), key, entry.data, { integrity: info.integrity, metadata: safeMetadata });
      records.push({ name, version: item.version, kind, url, key, bytes: entry.data.length,
        integrity: info.integrity, sha256: sha256(entry.data), metadataSha256: sha256(JSON.stringify(safeMetadata)) });
    }
    assert.ok(manifests > 0, `Missing cached public manifest for ${name}`);
    packageCount++;
  }
  assert.equal(packageCount, 18); assert.equal(tarballCount, 18);
  const manifest = { checkpoint: 403, packageLockSha256: sha256(lockBytes), productionPackages: packageCount,
    tarballs: tarballCount, manifests: manifestCount, entries: records.length, metadataSanitized: true,
    requestHeaderAllowlist: requestHeaders, responseHeaderAllowlist: responseHeaders,
    bodyBytesUnchanged: true, networkRequests: 0, sourceCacheChanged: false, records };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(destination, 'public-cache-manifest.json'), manifestBytes, { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ destination, productionPackages: packageCount, tarballs: tarballCount,
    manifests: manifestCount, entries: records.length, packageLockSha256: manifest.packageLockSha256,
    manifestSha256: sha256(manifestBytes) }) + '\n');
})().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
