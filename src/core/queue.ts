import axios from 'axios';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';

import config from '../config/env';
import logger from '../config/logger';
import { recordTaskFinished, recordTaskStarted } from './monitoring';
import { executeTask } from './task-runner';
import type { TaskPayload } from './task-types';

export const connection = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false
});

export const startTaskWorker = () => {
    const worker = new Worker<TaskPayload>(
        'astrid-jobs',
        async (job) => {
            logger.info({ taskId: job.data.taskId }, 'executing task');
            recordTaskStarted();

            try {
                const result = await executeTask(job.data);

                const stdoutLog = result.stdout.trimEnd();
                if (stdoutLog) {
                    await job.log(`[stdout]\n${stdoutLog}`);
                }

                const stderrLog = result.stderr.trimEnd();
                if (stderrLog) {
                    await job.log(`[stderr]\n${stderrLog}`);
                }

                try {
                    await axios.post(
                        `${config.apiUrl}/validators/${job.data.validatorId}/tasks/${job.data.taskId}/result`,
                        {
                            exitCode: result.exitCode,
                            stdout: result.stdout,
                            stderr: result.stderr
                        },
                        {
                            timeout: 10_000
                        }
                    );

                    logger.info({ taskId: job.data.taskId, exitCode: result.exitCode }, 'reported task result');
                } catch (err) {
                    logger.error({ err, taskId: job.data.taskId }, 'failed to report task');
                    throw err;
                }

                return result;
            } finally {
                recordTaskFinished();
            }
        },
        {
            connection,
            concurrency: config.maxConcurrentTasks
        }
    );

    worker.on('completed', (job) => {
        logger.info({ taskId: job.data.taskId }, 'task completed');
    });

    worker.on('failed', (job, err) => {
        logger.error({ taskId: job?.data.taskId, err }, 'task failed');
    });

    return worker;
};
