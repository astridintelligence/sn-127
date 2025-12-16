import { deriveExitCode, describeError, estimateArtifactSize, isBase64DataUri, safeJsonStringify } from './runner/utils';
import type { TaskArtifact, TaskPayload, TaskResult } from './task-types';

const MAX_FAILURE_REPORT_LENGTH = 16_000;

export function createTaskFailureResult(task: TaskPayload, err: unknown): TaskResult {
    const exitCode = deriveExitCode(err);

    const failureReport = {
        message: 'validator task execution failed',
        timestamp: new Date().toISOString(),
        exitCode,
        task: summarizeTaskForError(task),
        error: describeError(err)
    };

    return {
        exitCode,
        stdout: '',
        stderr: safeJsonStringify(failureReport, MAX_FAILURE_REPORT_LENGTH),
        artifacts: []
    };
}

function summarizeTaskForError(task: TaskPayload): Record<string, unknown> {
    return {
        taskId: task.taskId,
        jobId: task.jobId,
        validatorId: task.validatorId,
        runner: task.type,
        params: task.params ? Object.keys(task.params).sort() : [],
        environmentKeys: task.environment ? Object.keys(task.environment).sort() : [],
        artifacts: summarizeArtifactsForError(task.artifacts)
    };
}

function summarizeArtifactsForError(artifacts?: TaskArtifact[]): Array<Record<string, unknown>> | undefined {
    if (!artifacts || artifacts.length === 0) {
        return undefined;
    }

    return artifacts.map((artifact) => {
        const encoding = artifact.content.startsWith('data:') ? (isBase64DataUri(artifact.content) ? 'data-uri/base64' : 'data-uri') : 'inline';

        const entry: Record<string, unknown> = {
            name: artifact.name,
            encoding,
            ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {})
        };

        const size = estimateArtifactSize(artifact);
        if (size !== null) {
            entry.sizeBytes = size;
        }

        return entry;
    });
}
