import { TaskArtifact } from '../core/task-types';

export const parseCommand = (input: unknown): string[] => {
    if (Array.isArray(input) && input.every((value: string) => typeof value === 'string')) {
        return input.map((value: string) => value.trim()).filter((value: string) => value.length > 0);
    }

    return [];
};

export const parseEnvironment = (input: unknown): Record<string, string> | undefined => {
    if (!input || typeof input !== 'object') {
        return undefined;
    }

    const entries = Object.entries(input as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, value]) => {
        if (typeof value === 'string') {
            acc[key] = value;
        }
        return acc;
    }, {});

    return Object.keys(entries).length > 0 ? entries : undefined;
};

export const parseArtifacts = (input: unknown): TaskArtifact[] => {
    if (!Array.isArray(input)) {
        return [];
    }

    return input
        .map((artifact) => {
            if (!artifact || typeof artifact !== 'object') {
                return null;
            }

            const rawName = (artifact as Record<string, unknown>).name;
            const rawContent = (artifact as Record<string, unknown>).content;
            const rawMimeType = (artifact as Record<string, unknown>).mimeType;

            const name = typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : null;
            const content = typeof rawContent === 'string' ? rawContent : null;
            const mimeType = typeof rawMimeType === 'string' && rawMimeType.trim().length > 0 ? rawMimeType.trim() : null;

            if (!name || !content) {
                return null;
            }

            return {
                name,
                content,
                ...(mimeType ? { mimeType } : {})
            };
        })
        .filter((artifact): artifact is TaskArtifact => artifact !== null);
};
