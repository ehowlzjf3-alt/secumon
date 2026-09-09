import assert from 'node:assert/strict';
import { canonical } from '../dist/infrastructure/digest.js';
import { transferPageDigest, validateTransferManifest } from '../dist/infrastructure/postgres-transfer.js';

// Journal pages follow commit order; SQL exports follow table-key order. Compare every original
// row including duplicates, retaining exact text/number/boolean values and original page hashes.
export async function sameOriginalTransferRows(original, readOriginal, actual) {
  validateTransferManifest(original); validateTransferManifest(actual.manifest);
  const collect = async (manifest, read) => {
    const tables = new Map();
    for (const entry of manifest.pages) {
      const page = await read(entry.id);
      assert.equal(page.table, entry.table); assert.equal(page.rows.length, entry.rows);
      assert.equal(transferPageDigest(page), entry.digest);
      const table = tables.get(page.table) ?? { columns: page.columns, rows: [] };
      assert.deepEqual(table.columns, page.columns);
      table.rows.push(...page.rows.map(row => canonical(row)));
      tables.set(page.table, table);
    }
    return [...tables.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([name, table]) => ({ name, columns: table.columns, rows: table.rows.sort() }));
  };
  const actualPages = new Map(actual.pages.map(value => [value.id, value.page]));
  assert.equal(actualPages.size, actual.pages.length);
  assert.equal(actualPages.size, actual.manifest.pages.length);
  const expected = await collect(original, readOriginal);
  assert.deepEqual(await collect(actual.manifest, id => actualPages.get(id)), expected);
  return { tables: expected.length, rows: expected.reduce((total, table) => total + table.rows.length, 0) };
}
