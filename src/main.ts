import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { IoAdapter } from '@nestjs/platform-socket.io';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useWebSocketAdapter(new IoAdapter(app));

  app.setGlobalPrefix('api/v1', {
    exclude: ['admin/pipelines', 'admin/metrics', 'admin/metrics/:accountId', 'admin/health'],
  });

  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  }));

  const port = process.env['PORT'] ?? 3000;
  await app.listen(port);
  console.log(`BB Platform running on port ${port}`);
  console.log(`WS endpoint: ws://localhost:${port}/ws`);
}

bootstrap();
