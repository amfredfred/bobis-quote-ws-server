import { NestFactory } from '@nestjs/core';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { IoAdapter } from '@nestjs/platform-socket.io';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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
    origin: 'http://localhost:5173', // vite dev server
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    credentials: true,
  });

  const port = process.env['PORT'] ?? 3000;
  await app.listen(port);
  console.log(`BB Platform running on port ${port}`);
  console.log(`WS endpoint: ws://localhost:${port}/ws`);
}

bootstrap();
