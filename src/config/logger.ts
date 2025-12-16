import pino from 'pino';

import env from './env';

const logger = pino({
    level: env.logLevel,
    transport: !env.isProduction
        ? {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'SYS:standard' }
          }
        : undefined
});

export default logger;
