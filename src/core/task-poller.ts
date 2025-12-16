import axios from 'axios';

import config from '../config/env';
import logger from '../config/logger';
import { parseArtifacts, parseEnvironment } from '../utils/utils';
import { recordTaskFinished, recordTaskStarted } from './monitoring';
import { createTaskFailureResult } from './task-failure';
import { executeTask } from './task-runner';
import { extractTaskRunnerType, TaskResult, type TaskPayload } from './task-types';
import { getValidatorId } from './validator-state';

const POLL_INTERVAL_MS = 5_000;
const PENDING_STATUSES = new Set(['queued', 'dispatched', 'running', 'pending']);

interface ApiTaskArtifact {
    readonly name?: string;
    readonly content?: string;
    readonly mimeType?: string;
}

interface ApiTaskPayload {
    readonly type?: string;
    readonly environment?: Record<string, string>;
    readonly artifacts?: ApiTaskArtifact[] | null;
    readonly params?: Record<string, any>;
}

interface ApiTask {
    readonly taskId: string;
    readonly status: string;
    readonly validatorId?: string | null;
    readonly payload?: ApiTaskPayload | null;
}

interface ApiJob {
    readonly jobId: string;
    readonly tasks?: ApiTask[];
}

interface JobListResponse {
    readonly jobs?: ApiJob[];
}

export interface TaskPollerHandle {
    stop: () => Promise<void>;
}

const parseTasksForValidator = (jobs: readonly ApiJob[], validatorId: string, skipTaskIds: Set<string>, limit: number): TaskPayload[] => {
    const tasks: TaskPayload[] = [];

    for (const job of jobs) {
        if (!Array.isArray(job.tasks)) {
            continue;
        }

        for (const task of job.tasks) {
            if (typeof task.taskId !== 'string' || task.taskId.length === 0 || skipTaskIds.has(task.taskId)) {
                continue;
            }

            if (task.validatorId !== validatorId) {
                continue;
            }

            if (!PENDING_STATUSES.has(task.status)) {
                continue;
            }

            const payload = (task.payload ?? {}) as ApiTaskPayload;
            if (typeof payload !== 'object' || payload === null) {
                continue;
            }

            let type = extractTaskRunnerType(payload.type);
            if (type === null) {
                logger.warn({ taskId: task.taskId, type: payload.type }, 'skipping task with unsupported runner type');
                continue;
            }

            const environment = parseEnvironment(payload.environment);
            const artifacts = parseArtifacts(payload.artifacts);

            tasks.push({
                taskId: task.taskId,
                jobId: job.jobId,
                validatorId,
                type,
                environment: environment || {},
                artifacts: artifacts || [],
                params: payload.params || {}
            });

            if (tasks.length >= limit) {
                return tasks;
            }
        }
    }

    return tasks;
};

const fetchPendingTasks = async (validatorId: string, skipTaskIds: Set<string>, limit: number): Promise<TaskPayload[]> => {
    try {
        const { data } = await axios.get<JobListResponse>(`${config.apiUrl}/jobs`, { timeout: 5_000 });

        if (!data?.jobs || data.jobs.length === 0) {
            return [];
        }

        return parseTasksForValidator(data.jobs, validatorId, skipTaskIds, limit);
    } catch (err) {
        logger.error({ err }, 'failed to fetch pending tasks from API');
        return [];
    }
};

const submitTaskResult = async (task: TaskPayload, result: TaskResult): Promise<void> => {
    await axios.post(
        `${config.apiUrl}/validators/${task.validatorId}/tasks/${task.taskId}/result`,
        {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            ...(result.artifacts && result.artifacts.length > 0 ? { artifacts: result.artifacts } : {})
        },
        { timeout: 10_000 }
    );
};

const runTask = async (task: TaskPayload): Promise<void> => {
    recordTaskStarted();

    try {
        const executionResult = await executeTask(task);

        try {
            await submitTaskResult(task, executionResult);
            logger.info({ taskId: task.taskId, exitCode: executionResult.exitCode }, 'reported task result');
        } catch (reportErr) {
            logger.error({ err: reportErr, taskId: task.taskId }, 'failed to report task result');
            throw reportErr;
        }
    } catch (err) {
        const failureResult: TaskResult = createTaskFailureResult(task, err);
        const failurePreview = failureResult.stderr.length > 2_048 ? `${failureResult.stderr.slice(0, 2_048)}...[truncated]` : failureResult.stderr;
        logger.error({ err, taskId: task.taskId, failureReport: failurePreview }, 'task execution failed, reporting failure');

        try {
            await submitTaskResult(task, failureResult);
            logger.info({ taskId: task.taskId }, 'reported failure result for task');
        } catch (reportErr) {
            logger.error({ err: reportErr, taskId: task.taskId }, 'failed to report task failure result');
        }
    } finally {
        recordTaskFinished();
    }
};

export const startTaskPoller = (): TaskPollerHandle => {
    const activeTasks = new Map<string, Promise<void>>();
    let stopped = false;
    let polling = false;
    let timer: NodeJS.Timeout | null = null;

    const poll = async () => {
        if (polling || stopped) {
            return;
        }

        polling = true;
        try {
            let currentValidatorId: string;
            try {
                currentValidatorId = getValidatorId();
            } catch (err) {
                logger.error({ err }, 'task poller cannot determine validatorId; skipping cycle');
                return;
            }

            const availableSlots = config.maxConcurrentTasks - activeTasks.size;
            if (availableSlots <= 0) {
                return;
            }

            const pending = await fetchPendingTasks(currentValidatorId, new Set(activeTasks.keys()), availableSlots);

            if (pending.length === 0) {
                return;
            }

            for (const task of pending) {
                if (activeTasks.has(task.taskId)) {
                    continue;
                }

                const taskPromise = runTask(task).catch((err) => {
                    logger.error({ err, taskId: task.taskId }, 'task promise rejected');
                });

                activeTasks.set(task.taskId, taskPromise);
                void taskPromise.finally(() => {
                    activeTasks.delete(task.taskId);
                });
            }
        } finally {
            polling = false;
        }
    };

    timer = setInterval(() => {
        void poll();
    }, POLL_INTERVAL_MS);

    void poll();

    return {
        stop: async () => {
            stopped = true;
            if (timer) {
                clearInterval(timer);
            }

            await Promise.allSettled(activeTasks.values());
            activeTasks.clear();
        }
    };
};
