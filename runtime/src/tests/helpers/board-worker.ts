import { join } from 'node:path';
import { SqliteBoardRepository } from '../../infrastructure/sqlite-board.js';
import { FileBoardRepository } from '../../infrastructure/file-board.js';
import type { BoardCommit } from '../../application/board-ports.js';

const [adapter, directory] = process.argv.slice(2);
if (!directory || !['sqlite', 'file-journal'].includes(adapter ?? '')) throw new Error('invalid_board_worker');
const repository = adapter === 'sqlite' ? new SqliteBoardRepository(join(directory, 'board.sqlite')) : new FileBoardRepository(join(directory, 'boards'));
process.on('message', async (input: BoardCommit) => {
  const result = await repository.commit(input);
  process.send?.({ kind: result.kind, revision: 'revision' in result ? result.revision : null, pid: process.pid });
});
