export const JOB_TYPE_IMAGE = 'image';
export const JOB_TYPE_NPX = 'npx';
export const JOB_TYPE_SIMULATE_TRADE = 'simulate-trade';
export const JOB_TYPE_VALIDATE_TRANSACTION = 'validate-transaction';

export type TaskRunnerType = 'image' | 'npx' | 'simulate-trade' | 'validate-transaction';

export interface TaskArtifact {
    name: string;
    content: string;
    mimeType?: string;
}

export interface TaskPayload {
    taskId: string;
    jobId: string;
    validatorId: string;
    type: TaskRunnerType;
    environment?: Record<string, string>;
    artifacts?: TaskArtifact[];
    params: Record<string, any>;
}

export function extractTaskRunnerType(rawType: string | undefined): TaskRunnerType | null {
    if ([JOB_TYPE_IMAGE, JOB_TYPE_NPX, JOB_TYPE_SIMULATE_TRADE, JOB_TYPE_VALIDATE_TRANSACTION].includes(rawType || '')) {
        return rawType as TaskRunnerType;
    }

    return null;
}

export interface TaskResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    artifacts?: TaskArtifact[];
}
