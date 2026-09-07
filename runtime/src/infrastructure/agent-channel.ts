import type { LocalChannel } from './local-channel.js';
/** Public channel operations, independent of the SQLite implementation and its private connection. */
export type AgentChannel = Pick<LocalChannel, 'capabilities' | 'sessions' | 'send' | 'lookup' | 'recordConfirmedDelivery' | 'messages'> & {
  close(): void | Promise<void>;
};
