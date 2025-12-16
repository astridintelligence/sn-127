import { mkdir, writeFile } from 'fs/promises';
import util from 'node:util';
import path from 'path';

import { TaskArtifact } from '../task-types';

export function guessArtifactMimeType(filename: string): string | undefined {
    const extension = path.extname(filename).toLowerCase();

    switch (extension) {
        case '.json':
            return 'application/json';

        case '.csv':
            return 'text/csv';

        case '.txt':
        case '.log':
        case '.md':
            return 'text/plain';

        case '.html':
            return 'text/html';

        case '.pdf':
            return 'application/pdf';

        case '.png':
            return 'image/png';

        case '.jpg':
        case '.jpeg':
            return 'image/jpeg';

        case '.gif':
            return 'image/gif';

        default:
            return undefined;
    }
}

export function sanitizeArtifactPath(name: string): string {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
        throw new Error('artifact name cannot be empty');
    }

    const normalized = path.posix.normalize(trimmed.replace(/\\/g, '/')).replace(/^\.\/+/, '');

    if (normalized.length === 0 || normalized === '.' || normalized.includes('\0') || normalized.startsWith('..') || path.isAbsolute(normalized)) {
        throw new Error(`invalid artifact path: ${name}`);
    }

    return normalized;
}

export function decodeArtifactContent(artifact: TaskArtifact): Buffer {
    const { content } = artifact;

    if (content.startsWith('data:')) {
        const commaIndex = content.indexOf(',');
        if (commaIndex === -1) {
            throw new Error(`invalid data uri for artifact ${artifact.name ?? '<unknown>'}`);
        }

        const metadata = content.slice(0, commaIndex);
        const payload = content.slice(commaIndex + 1);

        if (metadata.includes(';base64')) {
            return Buffer.from(payload, 'base64');
        }

        return Buffer.from(payload, 'utf-8');
    }

    return Buffer.from(content, 'utf-8');
}

export function toDataUri(buffer: Buffer, mimeType?: string): string {
    return `data:${mimeType ?? 'application/octet-stream'};base64,${buffer.toString('base64')}`;
}

export function normalizeArtifactName(baseFolder: string, headerName: string): string | null {
    let candidate = headerName.replace(/^\.\//, '');
    const baseName = path.posix.basename(baseFolder);

    if (candidate.startsWith(`${baseName}/`)) {
        candidate = candidate.slice(baseName.length + 1);
    }

    if (candidate.endsWith('/')) {
        return null;
    }

    if (candidate.length === 0) {
        return null;
    }

    try {
        return sanitizeArtifactPath(candidate);
    } catch {
        return null;
    }
}

export async function materializeArtifacts(baseDir: string, artifacts?: TaskArtifact[]): Promise<Record<string, string>> {
    if (!artifacts || artifacts.length === 0) {
        return {};
    }

    const files: Record<string, string> = {};

    for (const artifact of artifacts) {
        const safePath = sanitizeArtifactPath(artifact.name);
        const absolutePath = path.join(baseDir, safePath);
        const parentDir = path.dirname(absolutePath);

        await mkdir(parentDir, { recursive: true });

        const fileContents = decodeArtifactContent(artifact);
        await writeFile(absolutePath, fileContents);

        files[artifact.name] = absolutePath;
    }

    return files;
}

export function buildProcessEnv(overrides?: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };

    if (overrides) {
        for (const [key, value] of Object.entries(overrides)) {
            env[key] = value;
        }
    }
    return env;
}

export function deriveExitCode(err: unknown): number {
    if (!err || typeof err !== 'object') {
        return 1;
    }

    const errorObject = err as Record<string, unknown>;

    const candidates = [errorObject.exitCode, errorObject.code, errorObject.statusCode, errorObject.status];

    for (const candidate of candidates) {
        const numeric = asFiniteNumber(candidate);
        if (numeric !== null) {
            return numeric;
        }
    }

    return 1;
}

function asFiniteNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
}

export function estimateArtifactSize(artifact: TaskArtifact): number | null {
    try {
        if (artifact.content.startsWith('data:')) {
            const commaIndex = artifact.content.indexOf(',');
            if (commaIndex === -1) {
                return null;
            }

            const payload = artifact.content.slice(commaIndex + 1);
            if (isBase64DataUri(artifact.content)) {
                return Math.floor((payload.length * 3) / 4);
            }

            return Buffer.byteLength(payload, 'utf-8');
        }

        return Buffer.byteLength(artifact.content, 'utf-8');
    } catch {
        return null;
    }
}

export function isBase64DataUri(value: string): boolean {
    const commaIndex = value.indexOf(',');
    if (commaIndex === -1) {
        return false;
    }

    const metadata = value.slice(0, commaIndex);

    return metadata.includes(';base64');
}

export function describeError(err: unknown, depth = 0): Record<string, unknown> {
    if (err instanceof Error) {
        const base: Record<string, unknown> = {
            name: err.name,
            message: err.message
        };

        if (err.stack) {
            base.stack = err.stack;
        }

        const errorWithProps = err as Error & Record<string, unknown>;

        const knownKeys: Array<keyof Error | string> = [
            'code',
            'errno',
            'syscall',
            'path',
            'statusCode',
            'status',
            'statusText',
            'signal',
            'exitCode',
            'reason',
            'detail'
        ];

        for (const key of knownKeys) {
            const value = errorWithProps[key];
            if (value !== undefined) {
                base[key] = value;
            }
        }

        const cause = (errorWithProps as { cause?: unknown }).cause;
        if (cause !== undefined && depth < 2) {
            base.cause = describeError(cause, depth + 1);
        }

        return base;
    }

    if (typeof err === 'object' && err !== null) {
        const constructorName = err.constructor && err.constructor.name ? err.constructor.name : 'Object';

        const simpleEntries = Object.entries(err as Record<string, unknown>).reduce<Record<string, unknown>>((acc, [key, value]) => {
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
                acc[key] = value;
            }
            return acc;
        }, {});

        const result: Record<string, unknown> = {
            type: constructorName
        };

        if (Object.keys(simpleEntries).length > 0) {
            result.summary = simpleEntries;
        } else {
            result.preview = util.inspect(err, { depth: 2 });
        }

        return result;
    }

    return {
        type: typeof err,
        value: err
    };
}

export function safeJsonStringify(value: unknown, limit: number): string {
    const seen = new WeakSet();

    const replacer = (_key: string, val: unknown) => {
        if (typeof val === 'bigint') {
            return val.toString();
        }

        if (typeof val === 'object' && val !== null) {
            if (seen.has(val as object)) {
                return '[Circular]';
            }
            seen.add(val as object);
        }
        return val;
    };

    try {
        let json = JSON.stringify(value, replacer, 2);
        if (json.length > limit) {
            const truncatedNote = `\n...[truncated ${json.length - limit} characters]`;
            json = `${json.slice(0, limit - truncatedNote.length)}${truncatedNote}`;
        }

        return json;
    } catch (err) {
        const reason = err instanceof Error ? err.message : util.inspect(err);
        return JSON.stringify(
            {
                error: 'Failed to serialize failure payload',
                reason
            },
            null,
            2
        );
    }
}
