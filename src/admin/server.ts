import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Queue } from 'bullmq';
import express from 'express';
import type { Server } from 'http';

import config from '../config/env';
import logger from '../config/logger';
import { connection } from '../core/queue';

export const startAdminServer = (): Server => {
    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/admin/queues');

    const queue = new Queue('astrid-jobs', { connection });

    createBullBoard({
        queues: [new BullMQAdapter(queue)],
        serverAdapter
    });

    const app = express();
    app.use('/admin/queues', serverAdapter.getRouter());

    const port = config.adminPort;
    const server = app.listen(port, () => {
        logger.info({ port }, 'bull board ui available at http://localhost:%d/admin/queues', port);
    });

    server.on('close', async () => {
        await queue.close();
    });

    return server;
};
