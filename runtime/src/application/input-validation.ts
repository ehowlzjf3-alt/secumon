import type { Clock } from './ports.js';

/** Host-only references. Neither node identities nor reader errors belong in model or public output. */
export interface InputReference { provider: string; key: string; expectedVersion?: string | undefined }
export interface InputNode {
  version: string;
  dependencies: InputReference[];
  bytesRead: number;
  validUntil?: number | null | undefined;
  /** Must check the captured resource and authority, without admitting new content or performing writes. */
  current(signal: AbortSignal): Promise<boolean>;
}
export interface InputNodeReader {
  provider: string;
  /** Readers are trusted, read-only adapters. Dependencies must be returned, not validated recursively. */
  inspect(key: string, signal: AbortSignal): Promise<InputNode | null>;
}
export interface InputValidationLimits { nodes: number; references: number; bytes: number; durationMs: number }
export type InputValidationResult = {
  valid: boolean;
  reason: 'current' | 'unavailable' | 'changed' | 'version_conflict' | 'limit' | 'cancelled';
  inspectedNodes: number; inspectedReferences: number; bytes: number;
};
const defaults: InputValidationLimits = { nodes: 256, references: 1024, bytes: 4 * 1024 * 1024, durationMs: 10000 };
const ceilings: InputValidationLimits = { nodes: 4096, references: 32768, bytes: 16 * 1024 * 1024, durationMs: 30000 };
const providerName = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
const name = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\u0000');
const refKey = (ref: InputReference) => JSON.stringify([ref.provider, ref.key]);
class InvalidInput extends Error {
  constructor(readonly reason: Exclude<InputValidationResult['reason'], 'current'>) { super(reason); }
}

/** One validation owns its queue, cancellation and snapshots; concurrent callers never share a visited set. */
export class InputValidationGraph {
  readonly #readers: Map<string, InputNodeReader['inspect']>;
  readonly #limits: InputValidationLimits;
  constructor(readers: readonly InputNodeReader[], readonly clock: Clock, limits: Partial<InputValidationLimits> = {}) {
    this.#limits = { ...defaults, ...limits };
    for (const key of Object.keys(defaults) as (keyof InputValidationLimits)[])
      if (!Number.isSafeInteger(this.#limits[key]) || this.#limits[key] < 1 || this.#limits[key] > ceilings[key]) throw new Error('input_validation_limits_invalid');
    this.#readers = new Map();
    for (const reader of readers) {
      if (!providerName(reader?.provider) || typeof reader.inspect !== 'function' || this.#readers.has(reader.provider)) throw new Error('input_reader_invalid');
      this.#readers.set(reader.provider, reader.inspect.bind(reader));
    }
  }
  async validate(roots: readonly InputReference[], options: { signal?: AbortSignal | undefined; accept?: (() => boolean) | undefined } = {}): Promise<InputValidationResult> {
    const { signal } = options;
    const controller = new AbortController();
    const startedAt = this.clock.now(), deadline = startedAt + this.#limits.durationMs;
    let timedOut = false, inspectedNodes = 0, inspectedReferences = 0, bytes = 0;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#limits.durationMs);
    const pending = new Map<string, InputReference>(), nodes = new Map<string, InputNode>(), expectations = new Map<string, Set<string>>();
    const queue: InputReference[] = [];
    const fail = (reason: InvalidInput['reason']): never => { throw new InvalidInput(reason); };
    const boundary = () => {
      if (signal?.aborted) fail('cancelled');
      const now = this.clock.now();
      if (timedOut || !Number.isSafeInteger(startedAt) || startedAt < 0 || !Number.isSafeInteger(deadline) ||
        !Number.isSafeInteger(now) || now < startedAt || now >= deadline) fail('limit');
      if (controller.signal.aborted) fail('cancelled');
    };
    const account = (amount: number) => {
      if (!Number.isSafeInteger(amount) || amount < 0 || amount > this.#limits.bytes - bytes) fail('limit'); bytes += amount;
    };
    const add = (ref: InputReference) => {
      boundary();
      if (!ref || !providerName(ref.provider) || !name(ref.key, 512) ||
        (ref.expectedVersion !== undefined && !name(ref.expectedVersion, 256)) ||
        Object.keys(ref).some(key => !['provider', 'key', 'expectedVersion'].includes(key))) fail('unavailable');
      if (++inspectedReferences > this.#limits.references) fail('limit');
      account(new TextEncoder().encode(JSON.stringify(ref)).byteLength);
      const key = refKey(ref), versions = expectations.get(key) ?? new Set<string>();
      if (ref.expectedVersion !== undefined) versions.add(ref.expectedVersion);
      expectations.set(key, versions);
      if (versions.size > 1 || (nodes.has(key) && versions.size && !versions.has(nodes.get(key)!.version))) fail('version_conflict');
      if (pending.has(key)) return;
      if (pending.size >= this.#limits.nodes) fail('limit');
      const captured = { ...ref }; pending.set(key, captured); queue.push(captured);
    };
    // Promise handlers stay attached after cancellation, so a late reader rejection cannot escape this operation.
    const operation = async <T>(invoke: () => Promise<T>): Promise<T> => {
      boundary();
      let abort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new InvalidInput(timedOut ? 'limit' : 'cancelled'));
        controller.signal.addEventListener('abort', abort, { once: true });
        if (controller.signal.aborted) abort();
      });
      try { const result = await Promise.race([Promise.resolve().then(() => { boundary(); return invoke(); }), aborted]); boundary(); return result; }
      finally { controller.signal.removeEventListener('abort', abort); }
    };
    const result = (valid: boolean, reason: InputValidationResult['reason']): InputValidationResult =>
      ({ valid, reason, inspectedNodes, inspectedReferences, bytes });
    try {
      boundary();
      if (!Array.isArray(roots) || roots.length > this.#limits.references) fail('limit');
      for (const ref of roots) add(ref);
      for (let index = 0; index < queue.length; index++) {
        boundary(); const ref = queue[index]!, inspect = this.#readers.get(ref.provider);
        if (!inspect) fail('unavailable');
        const node = await operation(() => inspect!(ref.key, controller.signal));
        if (!node || !name(node.version, 256) || !Array.isArray(node.dependencies) || typeof node.current !== 'function' ||
          (node.validUntil !== undefined && node.validUntil !== null && (!Number.isSafeInteger(node.validUntil) || node.validUntil < 0))) fail('unavailable');
        if (node!.validUntil != null && node!.validUntil <= this.clock.now()) fail('changed');
        if (node!.dependencies.length > this.#limits.references - inspectedReferences) fail('limit');
        account(node!.bytesRead);
        const captured: InputNode = { version: node!.version, dependencies: node!.dependencies.map(value => ({ ...value })),
          bytesRead: node!.bytesRead, validUntil: node!.validUntil, current: node!.current.bind(node) };
        const key = refKey(ref), expected = expectations.get(key)!;
        if (expected.size && !expected.has(captured.version)) fail('version_conflict');
        nodes.set(key, captured); inspectedNodes++;
        for (const dependency of captured.dependencies) add(dependency);
      }
      if (options.accept && options.accept() !== true) fail('unavailable');
      for (const node of nodes.values()) {
        if (node.validUntil != null && node.validUntil <= this.clock.now()) fail('changed');
        if (await operation(() => node.current(controller.signal)) !== true) fail('changed');
      }
      // A later node's guard can cross an earlier node's expiry.
      boundary();
      for (const node of nodes.values()) if (node.validUntil != null && node.validUntil <= this.clock.now()) fail('changed');
      return result(true, 'current');
    } catch (error) { return result(false, error instanceof InvalidInput ? error.reason : 'unavailable'); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.abort(); }
  }
}
