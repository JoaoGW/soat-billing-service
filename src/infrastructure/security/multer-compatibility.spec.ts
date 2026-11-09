import { Controller, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createRequire } from 'node:module';

@Controller('compatibility')
class CompatibilityController {
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { fileFilter: (_request, _file, callback) => { setImmediate(() => callback(null, true)); } }))
  upload(@UploadedFile() file: { originalname: string }) { return { name: file.originalname }; }
}

it('mantém compatibilidade do interceptor Nest com o Multer corrigido', async () => {
  const resolveFromNest = createRequire(createRequire(__filename).resolve('@nestjs/platform-express/package.json'));
  expect((resolveFromNest('multer/package.json') as { version: string }).version).toBe('2.5.0');
  const module = await Test.createTestingModule({ controllers: [CompatibilityController] }).compile();
  const app = module.createNestApplication();
  await app.init();
  try {
    const response = await request(app.getHttpServer()).post('/compatibility/upload').attach('file', Buffer.from('conteudo'), 'teste.txt').expect(201);
    expect(response.body).toEqual({ name: 'teste.txt' });
  } finally { await app.close(); }
});
