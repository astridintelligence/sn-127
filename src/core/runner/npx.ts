import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import logger from '../../config/logger';
import { JOB_TYPE_NPX, TaskPayload, type TaskResult } from '../task-types';
import { buildProcessEnv, materializeArtifacts } from './utils';

const TEMP_DIR_PREFIX = 'astrid-task-';

export async function executeNpxTask(task: TaskPayload): Promise<TaskResult> {
    const command = task.params.command;
    if (!Array.isArray(command) || command.length === 0 || !command.every((arg) => typeof arg === 'string')) {
        throw new Error('invalid or missing command for npx task');
    }

    logger.debug(
        {
            taskId: task.taskId,
            runner: JOB_TYPE_NPX,
            command: command,
            artifacts: task.artifacts?.map(({ name, mimeType }) => ({
                name,
                mimeType
            }))
        },
        'starting npx task execution'
    );

    const workspace = await mkdtemp(path.join(tmpdir(), `${TEMP_DIR_PREFIX}`));

    try {
        await materializeArtifacts(workspace, task.artifacts);

        const child = spawn('npx', ['--yes', ...command], {
            cwd: workspace,
            env: buildProcessEnv(task.environment),
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf-8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf-8');
        });

        const exitCode: number = await new Promise((resolve, reject) => {
            child.on('error', reject);
            child.on('close', (code) => {
                resolve(typeof code === 'number' ? code : 1);
            });
        });

        return { exitCode, stdout, stderr };
    } finally {
        try {
            await rm(workspace, { recursive: true, force: true });
        } catch (err) {
            logger.warn({ err, taskId: task.taskId, workspace }, 'failed to clean up npx workspace');
        }
    }
}
