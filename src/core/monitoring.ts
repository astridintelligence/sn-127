import os from 'node:os';
import si from 'systeminformation';

import config from '../config/env';
import logger from '../config/logger';

export interface CapacitySnapshot {
    cpu: number;
    memory: number;
    runningTasks: number;
}

type CpuSample = {
    idle: number;
    total: number;
};

const capacityState: CapacitySnapshot = {
    cpu: 0,
    memory: 0,
    runningTasks: 0
};

let runningTaskCount = 0;
let cpuSample: CpuSample | null = null;
let monitorTimer: NodeJS.Timeout | null = null;

const sampleCpu = (): CpuSample => {
    const summary = os.cpus().reduce<CpuSample>(
        (acc, cpu) => {
            const idle = cpu.times.idle;
            const total = idle + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq;

            acc.idle += idle;
            acc.total += total;

            return acc;
        },
        { idle: 0, total: 0 }
    );

    return summary;
};

const calculateCpuUsage = (): number => {
    const nextSample = sampleCpu();

    if (!cpuSample) {
        cpuSample = nextSample;
        return 0;
    }

    const idleDelta = nextSample.idle - cpuSample.idle;
    const totalDelta = nextSample.total - cpuSample.total;
    cpuSample = nextSample;

    if (totalDelta <= 0) {
        return 0;
    }

    const usage = 1 - idleDelta / totalDelta;
    return Math.max(0, Math.min(usage, 1));
};

const updateMemoryUsage = async (): Promise<number> => {
    const memData = await si.mem();
    if (memData.total === 0) {
        return 0;
    }

    const usedMemory = memData.total - memData.available;
    const usage = usedMemory / memData.total;

    return Math.max(0, Math.min(usage, 1));
};

const pollResourceUsage = async () => {
    try {
        const cpuUsage = calculateCpuUsage();
        const memoryUsage = await updateMemoryUsage();

        capacityState.cpu = Number((cpuUsage * 100).toFixed(2));
        capacityState.memory = Number((memoryUsage * 100).toFixed(2));
        capacityState.runningTasks = runningTaskCount;

        logger.trace({ capacity: capacityState }, 'updated validator resource metrics');
    } catch (err) {
        logger.warn({ err }, 'failed to update resource metrics');
    }
};

export const startMonitoringService = async (): Promise<NodeJS.Timeout> => {
    if (monitorTimer) {
        return monitorTimer;
    }

    cpuSample = sampleCpu();
    await pollResourceUsage();

    const interval = Math.max(1_000, Math.floor(config.heartbeatIntervalMs / 3));
    monitorTimer = setInterval(pollResourceUsage, interval);
    logger.info({ interval }, 'started resource monitoring service');

    return monitorTimer;
};

export const stopMonitoringService = () => {
    if (!monitorTimer) {
        return;
    }

    clearInterval(monitorTimer);
    monitorTimer = null;
    logger.info('stopped resource monitoring service');
};

export const recordTaskStarted = () => {
    runningTaskCount += 1;
    capacityState.runningTasks = runningTaskCount;
};

export const recordTaskFinished = () => {
    runningTaskCount = Math.max(0, runningTaskCount - 1);
    capacityState.runningTasks = runningTaskCount;
};

export const getCapacitySnapshot = (): CapacitySnapshot => ({
    ...capacityState
});
