import config from '../config/env';
import { Slack } from './slack';

const LEVEL_PRIORITY: Record<string, number> = { DEBUG: 0, INFO: 1, WARNING: 2, ERROR: 3 };

const slackSendHistory = new Map<string, number[]>();

function serializeData(data?: Record<string, any>): Record<string, any> {
    if (!data) {
        return {};
    }

    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
        if (value instanceof Error) {
            result[key] = { message: value.message, stack: value.stack, name: value.name };
        } else {
            result[key] = value;
        }
    }
    return result;
}

export function logMessage(level: string, message: string, data?: Record<string, any>): void {
    const minLevel = config.logLevel.toUpperCase();
    if ((LEVEL_PRIORITY[level] ?? 0) < (LEVEL_PRIORITY[minLevel] ?? 0)) {
        return;
    }

    console.log(
        JSON.stringify({
            severity: level,
            message,
            payload: serializeData(data),
            timestamp: new Date().toISOString()
        })
    );

    sendSlackMessage(level, message, data);
}

export function logError(message: string, data?: Record<string, any>): void {
    logMessage('ERROR', message, data);
}

export function logWarning(message: string, data?: Record<string, any>): void {
    logMessage('WARNING', message, data);
}

export function logInfo(message: string, data?: Record<string, any>): void {
    logMessage('INFO', message, data);
}

export function logDebug(message: string, data?: Record<string, any>): void {
    logMessage('DEBUG', message, data);
}

function sendSlackMessage(level: string, message: string, data?: Record<string, any>): void {
    if (level === 'INFO') {
        if (!data || data.slack !== true) {
            return;
        }
    } else if (level !== 'ERROR' && level !== 'WARNING') {
        return;
    }

    if (data && data.slack === false) {
        return;
    }

    if (!isWithinRateLimit(message)) {
        return;
    }

    const slackType = level === 'ERROR' ? 'error' : level === 'WARNING' ? 'warning' : 'info';
    const channel = level === 'ERROR' ? config.slackConfig.errorChannel : config.slackConfig.infoChannel;

    const { slack: _slack, ...slackData } = data ?? {};
    Slack.sendMessage(slackType, message, Object.keys(slackData).length > 0 ? slackData : undefined, channel ?? undefined);
}

function isWithinRateLimit(message: string): boolean {
    const now = Date.now();
    const windowMs = config.slackConfig.rateLimitWindowMs;
    const maxCount = config.slackConfig.rateLimitMax;

    let timestamps = slackSendHistory.get(message);
    if (timestamps) {
        timestamps = timestamps.filter((t) => now - t < windowMs);
        slackSendHistory.set(message, timestamps);
    } else {
        timestamps = [];
    }

    if (timestamps.length >= maxCount) {
        return false;
    }

    timestamps.push(now);
    slackSendHistory.set(message, timestamps);

    return true;
}
