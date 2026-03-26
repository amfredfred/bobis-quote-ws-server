'use strict'

import { NestFactory } from '@nestjs/core';
import { RequestMethod, ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { IoAdapter } from '@nestjs/platform-socket.io';

const logger = new Logger('Bootstrap');

// ── Prevent pg-pool / Prisma connection drops from killing the process ────────
// In production the pool recovers automatically. Without these handlers a
// transient DB disconnect terminates the Node process on local dev.
process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  // pg-pool throws "Connection terminated unexpectedly" on transient drops —
  // log it but let the pool reconnect rather than crashing.
  if (msg.includes('Connection terminated') || msg.includes('connect ECONNREFUSED')) {
    logger.warn(`DB connection drop (will recover): ${msg}`);
    return;
  }
  // All other unhandled rejections are real bugs — log them prominently.
  logger.error('Unhandled rejection', reason instanceof Error ? reason.stack : msg);
});

process.on('uncaughtException', (err: Error) => {
  logger.error('Uncaught exception', err.stack);
  // Give the logger time to flush before exiting on a real crash
  setTimeout(() => process.exit(1), 500);
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule);


  app.useGlobalGuards(new ThrottlerGuard());
  app.useWebSocketAdapter(new IoAdapter(app));
  app.setGlobalPrefix('api/v1', {
    exclude: [{ path: 'admin/(.*)', method: RequestMethod.ALL }]
  });

  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  }));

  app.enableCors({
    origin: process.env['CORS_ORIGIN'] ?? 'http://localhost:5173',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    credentials: true,
  });

  const port = process.env['PORT'] ?? 3000;
  await app.listen(port);
  logger.log(`BB Platform running on port ${port}`);
  logger.log(`WS endpoint: ws://localhost:${port}/ws`);
}

bootstrap().then().catch(console.error);
