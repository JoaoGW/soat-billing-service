import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { parse } from 'yaml';
import { AppModule } from './app.module';

it('documenta exatamente as rotas HTTP registradas e suas exigências de autenticação', () => {
  const document = parse(readFileSync(resolve(process.cwd(), 'docs/openapi.yaml'), 'utf8')) as { paths: Record<string, Record<string, Record<string, unknown>>> };
  const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AppModule) as Array<{ prototype: Record<string, unknown> }>;
  const actual: string[] = [];
  for (const controller of controllers) {
    const prefix = Reflect.getMetadata(PATH_METADATA, controller) as string;
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = controller.prototype[name];
      if (typeof handler !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined) continue;
      const suffix = Reflect.getMetadata(PATH_METADATA, handler) as string;
      const path = `/${prefix}/${suffix}`.replace(/\/+/g, '/').replace(/:(\w+)/g, '{$1}');
      actual.push(`${RequestMethod[method].toLowerCase()} ${path}`);
    }
  }
  const documented = Object.entries(document.paths).flatMap(([path, operations]) =>
    Object.keys(operations).filter(method => ['get', 'post', 'put', 'patch', 'delete'].includes(method)).map(method => `${method} ${path}`));
  expect(documented.sort()).toEqual(actual.sort());
  for (const entry of actual) {
    const [method, path] = entry.split(' ');
    const operation = document.paths[path][method];
    expect(operation.responses).toBeDefined();
    if (path !== '/health' && path !== '/webhooks/mercado-pago') expect(operation.security).toEqual([{ cliente: [] }]);
  }
});
