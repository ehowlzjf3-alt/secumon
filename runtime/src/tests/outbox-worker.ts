import { join } from 'node:path';
import { OutboxDispatcher } from '../application/outbox.js';
import { SqliteStateRepository } from '../infrastructure/sqlite-state.js';
import { LocalChannel } from '../infrastructure/local-channel.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import type { MessageSink } from '../application/ports.js';

const directory = process.argv[2]!; const workId = process.argv[3]!;
const state = new SqliteStateRepository(join(directory, 'state.sqlite'));
const channel = new LocalChannel(join(directory, 'channel.sqlite'));
const work = (await state.get(workId))!;
const sink: MessageSink = { capabilities: { idempotentSend: true }, lookup: d => channel.lookup(d), async send(d) {
  const receipt = await channel.send(d);
  process.send!({ persisted: receipt.status }, () => process.kill(process.pid, 'SIGKILL'));
  return new Promise(() => {});
} };
await new OutboxDispatcher({ state, sink, artifacts: new FileArtifactStore(join(directory, 'artifacts')), digester: new Sha256Digester(), clock: { now: () => work.createdAt } }, 'crash-sender', 1000).flush(workId, work.policy);
