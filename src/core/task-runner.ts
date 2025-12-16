import { executeDockerTask } from './runner/docker';
import { executeNpxTask } from './runner/npx';
import { executeSimulateTradeTask } from './runner/simulate-trade';
import { executeValidateTransactionTask } from './runner/validate-transaction';
import {
    JOB_TYPE_IMAGE,
    JOB_TYPE_NPX,
    JOB_TYPE_SIMULATE_TRADE,
    JOB_TYPE_VALIDATE_TRANSACTION,
    type TaskPayload,
    type TaskResult
} from './task-types';

export const executeTask = async (task: TaskPayload): Promise<TaskResult> => {
    switch (task.type) {
        case JOB_TYPE_IMAGE:
            return executeDockerTask(task);
        case JOB_TYPE_NPX:
            return executeNpxTask(task);
        case JOB_TYPE_SIMULATE_TRADE:
            return executeSimulateTradeTask(task);
        case JOB_TYPE_VALIDATE_TRANSACTION:
            return executeValidateTransactionTask(task);
        default:
            throw new Error(`unsupported task type: ${(task as TaskPayload).type}`);
    }
};
