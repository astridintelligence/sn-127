import Docker, { type Container } from 'dockerode';
import path from 'path';
import { PassThrough } from 'stream';
import tar from 'tar-stream';

import config from '../../config/env';
import logger from '../../config/logger';
import { JOB_TYPE_IMAGE, TaskPayload, type TaskArtifact, type TaskResult } from '../task-types';
import { guessArtifactMimeType, normalizeArtifactName, toDataUri } from './utils';

const DEFAULT_JOB_OUTPUT_FOLDER = './result';
const MAX_COLLECTED_ARTIFACTS = 32;
const MAX_SINGLE_ARTIFACT_SIZE_BYTES = 4 * 1024 * 1024; // 4 MiB
const MAX_TOTAL_ARTIFACT_SIZE_BYTES = 16 * 1024 * 1024; // 16 MiB

const docker = new Docker({ socketPath: config.dockerSocketPath });
const dockerModem: any = docker.modem;

export async function executeDockerTask(task: TaskPayload): Promise<TaskResult> {
    const existingEnvEntries = Object.entries(task.environment ?? {});
    const jobOutputValue = (task.environment && task.environment.JOB_OUTPUT_FOLDER) ?? DEFAULT_JOB_OUTPUT_FOLDER;
    const resolvedOutputFolder = resolveJobOutputFolder(jobOutputValue);

    const image = task.params.image;
    if (typeof image !== 'string' || image.length === 0) {
        throw new Error('invalid or missing image for docker task');
    }

    const command = task.params.command;

    logger.debug(
        {
            taskId: task.taskId,
            runner: JOB_TYPE_IMAGE,
            image: image,
            command: command
        },
        'starting docker task execution'
    );

    await pullImage(image);

    const envEntries = existingEnvEntries.some(([key]) => key === 'JOB_OUTPUT_FOLDER')
        ? existingEnvEntries
        : [...existingEnvEntries, ['JOB_OUTPUT_FOLDER', jobOutputValue]];

    const container = await docker.createContainer({
        Image: image,
        Cmd: command && command.length > 0 ? command : undefined,
        Env: envEntries.map(([k, v]) => `${k}=${v}`),
        HostConfig: {
            NetworkMode: 'none',
            Memory: 512 * 1024 * 1024,
            NanoCpus: 1_000_000_000
        },
        WorkingDir: '/tmp'
    });

    const stream = await container.attach({
        stream: true,
        stdout: true,
        stderr: true
    });

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();

    let stdout = '';
    let stderr = '';

    stdoutStream.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8');
    });
    stderrStream.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
    });

    dockerModem.demuxStream(stream, stdoutStream, stderrStream);

    await container.start();

    const streamCompleted = new Promise<void>((resolve, reject) => {
        stream.on('end', resolve);
        stream.on('close', resolve);
        stream.on('error', reject);
    });

    const { StatusCode } = await container.wait();
    const exitCode = StatusCode ?? 1;

    // Only wait for stream completion if the stream is not destroyed
    if (!(stream as any).destroyed) {
        try {
            await streamCompleted;
        } catch (err) {
            logger.warn({ err, taskId: task.taskId }, 'error while reading container io');
        }
    }

    stdoutStream.end();
    stderrStream.end();

    let artifacts: TaskArtifact[] = [];
    if (resolvedOutputFolder) {
        try {
            artifacts = await collectDockerArtifacts(container, resolvedOutputFolder);
        } catch (err) {
            logger.warn({ err, taskId: task.taskId, outputFolder: resolvedOutputFolder }, 'failed to collect artifacts from docker task');
        }
    }

    await container.remove({ force: true });

    return {
        exitCode,
        stdout,
        stderr,
        ...(artifacts.length > 0 ? { artifacts } : {})
    };
}

function resolveJobOutputFolder(rawFolder: string | undefined): string | null {
    const trimmed = rawFolder?.trim();
    const base = '/tmp';
    const normalized = trimmed && trimmed.length > 0 ? path.posix.normalize(trimmed.replace(/\\/g, '/')) : DEFAULT_JOB_OUTPUT_FOLDER;

    const withoutLeadingDot = normalized.replace(/^\.\/+/, '');
    const absolutePath = path.posix.isAbsolute(normalized) ? normalized : path.posix.join(base, withoutLeadingDot);

    const resolved = path.posix.normalize(absolutePath);
    if (!resolved.startsWith(`${base}/`) && resolved !== base) {
        logger.warn({ requestedFolder: rawFolder, resolvedFolder: resolved }, 'skipping job output collection outside /tmp');
        return null;
    }

    return resolved;
}

async function pullImage(image: string): Promise<Promise<void>> {
    return new Promise<void>((resolve, reject) => {
        docker.pull(image, (err: any, stream: any) => {
            if (err) {
                reject(err);
                return;
            }

            dockerModem.followProgress(stream, (followErr: Error | null) => {
                if (followErr) {
                    reject(followErr);
                } else {
                    logger.debug({ image }, 'pulled docker image');
                    resolve();
                }
            });
        });
    });
}

async function collectDockerArtifacts(container: Container, outputFolder: string): Promise<TaskArtifact[]> {
    let archiveStream: NodeJS.ReadableStream;

    try {
        archiveStream = await container.getArchive({ path: outputFolder });
    } catch (err) {
        if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode?: number }).statusCode === 404) {
            logger.debug({ outputFolder }, 'job output folder not found in container; skipping artifact collection');
            return [];
        }

        logger.warn({ err, outputFolder }, 'failed to read job output folder from container');
        return [];
    }

    const artifacts: TaskArtifact[] = [];
    let totalSize = 0;

    const extract = tar.extract();

    const finishedExtraction = new Promise<void>((resolve, reject) => {
        extract.on('entry', (header, stream, next) => {
            if (artifacts.length >= MAX_COLLECTED_ARTIFACTS) {
                stream.resume();
                stream.on('end', next);
                stream.on('error', reject);
                return;
            }

            if (header.type !== 'file') {
                stream.resume();
                stream.on('end', next);
                stream.on('error', reject);
                return;
            }

            const normalizedName = normalizeArtifactName(outputFolder, header.name);
            if (!normalizedName) {
                stream.resume();
                stream.on('end', next);
                stream.on('error', reject);
                return;
            }

            const mimeType = guessArtifactMimeType(normalizedName);

            const chunks: Buffer[] = [];
            let size = 0;
            let skipped = false;

            stream.on('data', (chunk: Buffer) => {
                if (skipped) {
                    return;
                }

                const projectedSize = size + chunk.length;
                const projectedTotal = totalSize + chunk.length;

                if (projectedSize > MAX_SINGLE_ARTIFACT_SIZE_BYTES || projectedTotal > MAX_TOTAL_ARTIFACT_SIZE_BYTES) {
                    skipped = true;
                    logger.warn(
                        {
                            name: normalizedName,
                            projectedSize,
                            projectedTotal
                        },
                        'skipping artifact exceeding size limits'
                    );
                    return;
                }

                size = projectedSize;
                totalSize = projectedTotal;
                chunks.push(chunk);
            });

            stream.on('end', () => {
                if (!skipped && size > 0) {
                    const buffer = Buffer.concat(chunks);
                    artifacts.push({
                        name: normalizedName,
                        content: toDataUri(buffer, mimeType),
                        ...(mimeType ? { mimeType } : {})
                    });
                }
                next();
            });

            stream.on('error', reject);
        });

        extract.on('finish', resolve);
        extract.on('error', reject);
    });

    archiveStream.pipe(extract);

    await finishedExtraction;

    return artifacts;
}
