import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { simulateTrade } from 'sigmaarena-vm/commands/simulate-trade/simulate_trade';
import logger from '../../config/logger';
import { JOB_TYPE_SIMULATE_TRADE, type TaskPayload, type TaskResult } from '../task-types';
import { materializeArtifacts } from './utils';

const TEMP_DIR_PREFIX = 'astrid-task-simulate-trade';

export async function executeSimulateTradeTask(task: TaskPayload): Promise<TaskResult> {
    logger.debug(
        {
            taskId: task.taskId,
            runner: JOB_TYPE_SIMULATE_TRADE,
            artifacts: task.artifacts?.map(({ name, mimeType }) => ({
                name,
                mimeType
            }))
        },
        'Starting simulate-trade task execution'
    );

    const artifactNames = task.artifacts?.map((a) => a.name) || [];
    const requiredArtifacts: string[] = ['config.json', 'strategy.ts'];

    for (const requiredArtifact of requiredArtifacts) {
        if (!artifactNames.includes(requiredArtifact)) {
            const errorMsg = `Missing required artifact: ${requiredArtifact}`;
            throw new Error(errorMsg);
        }
    }

    const workspace = await mkdtemp(path.join(tmpdir(), TEMP_DIR_PREFIX));

    try {
        const files = await materializeArtifacts(workspace, task.artifacts);

        const outcome = await simulateTrade([files['config.json'], files['strategy.ts'], 'false']);

        return {
            exitCode: 0,
            artifacts: [{ name: 'simulation_result.json', content: JSON.stringify(outcome), mimeType: 'application/json' }],
            stdout: '',
            stderr: ''
        };
    } finally {
        try {
            await rm(workspace, { recursive: true, force: true });
        } catch (err) {
            logger.warn({ err, taskId: task.taskId, workspace }, 'Failed to clean up simulate-trade workspace');
        }
    }
}
