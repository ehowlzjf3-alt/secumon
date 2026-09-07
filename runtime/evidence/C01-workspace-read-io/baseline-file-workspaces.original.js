import { constants, closeSync, fsyncSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WorkspaceError } from '../application/workspace-checkpoints.js';
import { WorkspaceFileSchema, WorkspacePathSchema } from '../application/workspace-contracts.js';
import { parseContract } from '../application/contracts.js';
import { sha256 } from './digest.js';
import { storageRootParts } from './local-file-paths.js';
import { FileBoundaryFault, hostMetadataFiles } from './host-metadata-files.js';
const idSchema = z.string().min(1).max(256);
const recordSchema = z.strictObject({ schemaVersion: z.literal(1), file: WorkspaceFileSchema, contentBase64: z.string(), checksum: z.string().regex(/^[a-f0-9]{64}$/) });
const errorCode = (error) => error?.code;
export class FileWorkspaceStore {
    #root;
    #files;
    #parentDirectory;
    #directories = new Map();
    #closed = false;
    limits;
    constructor(directory, options = {}) {
        try {
            this.#files = hostMetadataFiles();
        }
        catch (error) {
            this.#boundaryFailure(error);
        }
        this.limits = Object.freeze({ maxFileBytes: 1048576, maxFilesPerAttempt: 128, maxAttemptBytes: 16777216, ...options });
        if (Object.values(this.limits).some(value => !Number.isSafeInteger(value) || value < 1))
            throw new WorkspaceError('invalid_workspace_configuration');
        const parts = storageRootParts(directory);
        if (!parts)
            throw new WorkspaceError('workspace_root_invalid');
        const parent = realpathSync(parts.parent);
        this.#parentDirectory = this.#inspect(parent, undefined, 'sync');
        this.#root = join(parent, parts.name);
        const root = this.#directory(this.#root, true);
        this.#sync(root);
        this.#sync(this.#parentDirectory);
    }
    #boundaryFailure(error) {
        if (!(error instanceof FileBoundaryFault))
            throw error;
        if (error.code === 'unsafe')
            throw new WorkspaceError('workspace_directory_unsafe', { cause: error });
        if (error.code === 'changed')
            throw new WorkspaceError('workspace_directory_changed', { cause: error });
        if (error.code === 'unsupported_platform')
            throw new WorkspaceError('workspace_platform_unsupported', { cause: error });
        if ((error.code === 'io' || error.code === 'missing') && error.cause !== undefined)
            throw error.cause;
        throw error;
    }
    #inspect(path, expected, access = 'private', lock = false) {
        try {
            const directory = this.#files.inspectDirectory(path, access, expected);
            if (directory)
                return directory;
            if (lock)
                throw new WorkspaceError('workspace_lock_lost');
            throw Object.assign(new Error('directory does not exist'), { code: 'ENOENT', syscall: 'lstat', path });
        }
        catch (error) {
            this.#boundaryFailure(error);
        }
    }
    #directory(path, create = false) {
        const expected = this.#directories.get(path);
        if (create && !expected) {
            try {
                mkdirSync(path, { mode: 0o700 });
            }
            catch (error) {
                if (errorCode(error) !== 'EEXIST')
                    throw error;
            }
        }
        const directory = this.#inspect(path, expected);
        this.#directories.set(path, directory);
        return directory;
    }
    #sync(directory) {
        try {
            this.#files.syncDirectory(directory);
        }
        catch (error) {
            this.#boundaryFailure(error);
        }
    }
    #scope(workId, attemptId) {
        if (this.#closed)
            throw new WorkspaceError('workspace_store_closed');
        parseContract(idSchema, workId);
        parseContract(idSchema, attemptId);
        this.#directory(this.#root);
        const work = join(this.#root, sha256(workId));
        this.#directory(work, true);
        const attempt = join(work, sha256(attemptId));
        this.#directory(attempt, true);
        return { work, attempt };
    }
    #locked(workId, attemptId, action) {
        const scope = this.#scope(workId, attemptId);
        const lock = join(scope.attempt, '.lock');
        try {
            mkdirSync(lock, { mode: 0o700 });
        }
        catch (error) {
            if (errorCode(error) === 'EEXIST')
                throw new WorkspaceError('workspace_busy');
            throw error;
        }
        // A lock belongs to one invocation. A later invocation creates a new directory.
        const acquired = this.#inspect(lock, undefined, 'private', true);
        let outcome;
        try {
            this.#directory(this.#root);
            this.#directory(scope.work);
            this.#directory(scope.attempt);
            const folder = join(scope.attempt, 'files');
            this.#directory(folder, true);
            this.#inspect(lock, acquired, 'private', true);
            const value = action(folder);
            const root = this.#directory(this.#root);
            const work = this.#directory(scope.work);
            const attempt = this.#directory(scope.attempt);
            const files = this.#directory(folder);
            this.#inspect(lock, acquired, 'private', true);
            this.#sync(files);
            this.#sync(attempt);
            this.#sync(work);
            this.#sync(root);
            this.#sync(this.#parentDirectory);
            this.#directory(this.#root);
            this.#directory(scope.work);
            this.#directory(scope.attempt);
            this.#directory(folder);
            this.#inspect(lock, acquired, 'private', true);
            outcome = { ok: true, value };
        }
        catch (error) {
            outcome = { ok: false, error };
        }
        try {
            // Do not remove a lock reached through a substituted ancestor.
            this.#directory(this.#root);
            this.#directory(scope.work);
            const attempt = this.#directory(scope.attempt);
            this.#inspect(lock, acquired, 'private', true);
            rmdirSync(lock);
            this.#sync(attempt);
            if (outcome.ok) {
                this.#directory(this.#root);
                this.#directory(scope.work);
                this.#directory(scope.attempt);
                this.#directory(join(scope.attempt, 'files'));
            }
        }
        catch (cleanupError) {
            if (outcome.ok)
                throw cleanupError;
            const code = errorCode(outcome.error);
            throw new WorkspaceError(typeof code === 'string' ? code : 'workspace_operation_failed', { cause: outcome.error, cleanupError });
        }
        if (!outcome.ok)
            throw outcome.error;
        return outcome.value;
    }
    #read(folder, workId, attemptId, path) {
        const stored = join(folder, `${sha256(path)}.json`);
        let fd;
        try {
            fd = openSync(stored, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        }
        catch (error) {
            if (errorCode(error) === 'ENOENT')
                throw new WorkspaceError('workspace_file_unavailable');
            throw new WorkspaceError('workspace_file_unsafe');
        }
        try {
            const stat = fstatSync(fd);
            if (!stat.isFile() || (stat.mode & 0o077) !== 0 || typeof process.getuid === 'function' && stat.uid !== process.getuid())
                throw new WorkspaceError('workspace_file_unsafe');
            if (stat.size > Math.ceil(this.limits.maxFileBytes * 4 / 3) + 65536)
                throw new WorkspaceError('workspace_file_too_large');
            const serialized = readFileSync(fd);
            if (serialized.length !== stat.size)
                throw new WorkspaceError('workspace_file_integrity_failure');
            let record;
            try {
                record = parseContract(recordSchema, JSON.parse(serialized.toString('utf8')));
            }
            catch {
                throw new WorkspaceError('workspace_file_integrity_failure');
            }
            const { checksum, ...payload } = record;
            const bytes = Buffer.from(record.contentBase64, 'base64');
            if (sha256(JSON.stringify(payload)) !== checksum || bytes.toString('base64') !== record.contentBase64 || bytes.byteLength !== record.file.byteLength || sha256(bytes) !== record.file.sha256)
                throw new WorkspaceError('workspace_file_integrity_failure');
            if (record.file.workId !== workId || record.file.attemptId !== attemptId || record.file.path !== path)
                throw new WorkspaceError('workspace_file_identity_mismatch');
            if (bytes.length > this.limits.maxFileBytes)
                throw new WorkspaceError('workspace_file_too_large');
            return { file: record.file, bytes };
        }
        finally {
            closeSync(fd);
        }
    }
    #list(folder, workId, attemptId) {
        const names = readdirSync(folder).sort();
        const files = [];
        for (const name of names) {
            if (!/^[a-f0-9]{64}\.json$/.test(name))
                throw new WorkspaceError(name.endsWith('.pending') ? 'workspace_incomplete_write' : 'workspace_layout_invalid');
            const stored = join(folder, name);
            let fd;
            try {
                fd = openSync(stored, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            }
            catch {
                throw new WorkspaceError('workspace_file_unsafe');
            }
            let path;
            try {
                const stat = fstatSync(fd);
                if (!stat.isFile() || (stat.mode & 0o077) !== 0 || typeof process.getuid === 'function' && stat.uid !== process.getuid() || stat.size > Math.ceil(this.limits.maxFileBytes * 4 / 3) + 65536)
                    throw new WorkspaceError('workspace_file_unsafe');
                try {
                    path = parseContract(recordSchema, JSON.parse(readFileSync(fd).toString('utf8'))).file.path;
                }
                catch {
                    throw new WorkspaceError('workspace_file_integrity_failure');
                }
            }
            finally {
                closeSync(fd);
            }
            if (`${sha256(path)}.json` !== name)
                throw new WorkspaceError('workspace_file_identity_mismatch');
            files.push(this.#read(folder, workId, attemptId, path).file);
        }
        return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    }
    async stage(workId, attemptId, path, bytes, attributes) {
        path = parseContract(WorkspacePathSchema, path);
        const content = Buffer.from(bytes);
        if (content.length > this.limits.maxFileBytes)
            throw new WorkspaceError('workspace_file_too_large');
        const file = parseContract(WorkspaceFileSchema, { workId, attemptId, path, ...attributes, labels: [...new Set(attributes.labels)].sort(), byteLength: content.length, sha256: sha256(content) });
        return this.#locked(workId, attemptId, folder => {
            const files = this.#list(folder, workId, attemptId);
            const existing = files.find(value => value.path === path);
            if (existing) {
                if (JSON.stringify(existing) !== JSON.stringify(file))
                    throw new WorkspaceError('workspace_file_conflict');
                return structuredClone(existing);
            }
            if (files.length >= this.limits.maxFilesPerAttempt || files.reduce((total, value) => total + value.byteLength, 0) + file.byteLength > this.limits.maxAttemptBytes)
                throw new WorkspaceError('workspace_capacity_exceeded');
            const payload = { schemaVersion: 1, file, contentBase64: content.toString('base64') };
            const serialized = Buffer.from(JSON.stringify({ ...payload, checksum: sha256(JSON.stringify(payload)) }));
            if (serialized.length > Math.ceil(this.limits.maxFileBytes * 4 / 3) + 65536)
                throw new WorkspaceError('workspace_file_too_large');
            const candidate = join(folder, `${randomUUID()}.pending`);
            const fd = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            try {
                writeFileSync(fd, serialized);
                fsyncSync(fd);
            }
            finally {
                closeSync(fd);
            }
            try {
                linkSync(candidate, join(folder, `${sha256(path)}.json`));
            }
            catch (error) {
                if (errorCode(error) === 'EEXIST')
                    throw new WorkspaceError('workspace_file_conflict');
                throw error;
            }
            finally {
                unlinkSync(candidate);
            }
            return structuredClone(file);
        });
    }
    async read(workId, attemptId, path) {
        path = parseContract(WorkspacePathSchema, path);
        return this.#locked(workId, attemptId, folder => { const stored = this.#read(folder, workId, attemptId, path); return { file: structuredClone(stored.file), bytes: new Uint8Array(stored.bytes) }; });
    }
    async list(workId, attemptId) { return this.#locked(workId, attemptId, folder => structuredClone(this.#list(folder, workId, attemptId))); }
    async removeAttempt(workId, attemptId, expectedFiles) {
        const expected = expectedFiles.map(file => parseContract(WorkspaceFileSchema, file)).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
        this.#locked(workId, attemptId, folder => {
            const current = this.#list(folder, workId, attemptId);
            if (JSON.stringify(current) !== JSON.stringify(expected))
                throw new WorkspaceError('workspace_manifest_changed');
            for (const file of current)
                unlinkSync(join(folder, `${sha256(file.path)}.json`));
        });
    }
    async close() { this.#closed = true; this.#directories.clear(); }
}
//# sourceMappingURL=file-workspaces.js.map