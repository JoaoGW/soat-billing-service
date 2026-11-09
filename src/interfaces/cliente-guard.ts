import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { verify } from 'jsonwebtoken';

export type ClienteRequest = { headers: Record<string, string | string[] | undefined>; clienteId?: string };

@Injectable()
export class ClienteGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ClienteRequest>();
    const header = req.headers.authorization;
    const secret = process.env.JWT_CLIENT_SECRET;
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32 || typeof header !== 'string' || !header.startsWith('Bearer ')) throw new UnauthorizedException();
    try {
      const payload = verify(header.slice(7), secret, {
        algorithms: ['HS256'],
        issuer: process.env.JWT_CLIENT_ISSUER || 'soat-auth-function',
        audience: process.env.JWT_CLIENT_AUDIENCE || 'soat-api',
      });
      if (typeof payload === 'string' || payload.role !== 'cliente' || typeof payload.sub !== 'string' || !payload.sub.trim() || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) throw new Error('Claims inválidas');
      req.clienteId = payload.sub;
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
