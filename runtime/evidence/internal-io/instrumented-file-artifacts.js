import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ArtifactSchema, parseContract } from '../application/contracts.js';
import { sha256 } from './digest.js';
const emptyMetrics = () => ({ getCalls: 0, existsCalls: 0, putCalls: 0, metadataReadOperations: 0, metadataReadBytes: 0,
    bodyReadOperations: 0, bodyReadBytes: 0, hashCalls: 0, hashBytes: 0, fileWrites: 0, metadataWriteBytes: 0, bodyWriteBytes: 0,
    readFailures: 0, verificationFailures: 0, deniedReads: 0, writeFailures: 0 });
export class FileArtifactStore {
    #root;
    #metrics = emptyMetrics();
    constructor(root) { this.#root = resolve(root); }
    /** Instance counters for Node readFile/writeFile calls, not kernel syscalls or physical disk activity. Bytes count completed calls; failed partial I/O is unknown. */
    metrics() { return Object.freeze({ ...this.#metrics }); }
    /** Reset at a quiescent boundary when comparing whole operations; in-flight completions are counted when they occur. */
    resetMetrics() { this.#metrics = emptyMetrics(); }
    #hash(bytes) {
        this.#metrics.hashCalls++;
        this.#metrics.hashBytes += typeof bytes === 'string' ? Buffer.byteLength(bytes, 'utf8') : bytes.byteLength;
        return sha256(bytes);
    }
    #path(id, extension) {
        if (!/^[a-f0-9]{64}$/.test(id))
            throw new Error('invalid_artifact_id');
        return join(this.#root, `${id}.${extension}`);
    }
    async #read(path, part) {
        try {
            const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const stat = await handle.stat();
                if (!stat.isFile())
                    throw new Error('invalid_artifact_file');
                if (part === 'metadata')
                    this.#metrics.metadataReadOperations++;
                else
                    this.#metrics.bodyReadOperations++;
                const bytes = await handle.readFile();
                if (part === 'metadata')
                    this.#metrics.metadataReadBytes += bytes.byteLength;
                else
                    this.#metrics.bodyReadBytes += bytes.byteLength;
                return bytes;
            }
            finally {
                await handle.close();
            }
        }
        catch (error) {
            this.#metrics.readFailures++;
            throw error;
        }
    }
    async #atomic(path, bytes, part) {
        const temp = `${path}.${randomUUID()}.pending`;
        const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try {
            this.#metrics.fileWrites++;
            try {
                await handle.writeFile(bytes);
            }
            catch (error) {
                this.#metrics.writeFailures++;
                throw error;
            }
            if (part === 'metadata')
                this.#metrics.metadataWriteBytes += bytes.byteLength;
            else
                this.#metrics.bodyWriteBytes += bytes.byteLength;
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        try {
            await rename(temp, path);
        }
        catch (error) {
            await unlink(temp).catch(() => { });
            throw error;
        }
        const directory = await open(this.#root, constants.O_RDONLY);
        try {
            await directory.sync();
        }
        finally {
            await directory.close();
        }
    }
    async put(bytes, attributes) {
        this.#metrics.putCalls++;
        const labels = [...new Set(attributes.labels)].sort();
        const hash = this.#hash(bytes);
        const id = this.#hash(JSON.stringify({ hash, tenantId: attributes.tenantId, labels, mediaType: attributes.mediaType }));
        const ref = parseContract(ArtifactSchema, { id, sha256: hash, byteLength: bytes.length, mediaType: attributes.mediaType, tenantId: attributes.tenantId, labels });
        await mkdir(this.#root, { recursive: true, mode: 0o700 });
        if (await this.exists(ref))
            return ref;
        await this.#atomic(this.#path(id, 'blob'), bytes, 'body');
        await this.#atomic(this.#path(id, 'json'), Buffer.from(JSON.stringify(ref)), 'metadata');
        return ref;
    }
    async #verified(ref) {
        try {
            parseContract(ArtifactSchema, ref);
            const stored = parseContract(ArtifactSchema, JSON.parse((await this.#read(this.#path(ref.id, 'json'), 'metadata')).toString('utf8')));
            if (stored.sha256 !== ref.sha256 || stored.byteLength !== ref.byteLength || stored.tenantId !== ref.tenantId || stored.mediaType !== ref.mediaType ||
                JSON.stringify(stored.labels) !== JSON.stringify(ref.labels) || stored.id !== ref.id)
                throw new Error('artifact_reference_mismatch');
            const bytes = await this.#read(this.#path(ref.id, 'blob'), 'body');
            if (bytes.length !== ref.byteLength || this.#hash(bytes) !== ref.sha256)
                throw new Error('artifact_integrity_failure');
            return bytes;
        }
        catch (error) {
            this.#metrics.verificationFailures++;
            throw error;
        }
    }
    async get(ref, policy) {
        this.#metrics.getCalls++;
        if (ref.tenantId !== policy.tenantId || !ref.labels.every(l => policy.allowedLabels.includes(l))) {
            this.#metrics.deniedReads++;
            throw new Error('artifact_access_denied');
        }
        return this.#verified(ref);
    }
    async exists(ref) {
        this.#metrics.existsCalls++;
        try {
            await this.#verified(ref);
            return true;
        }
        catch {
            return false;
        }
    }
}
//# sourceMappingURL=file-artifacts.js.map