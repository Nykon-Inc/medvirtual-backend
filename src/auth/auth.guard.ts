import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as jwt from 'jsonwebtoken';
import { Request } from 'express';
import * as Sentry from '@sentry/nestjs';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        'Authorization header is missing or invalid',
      );
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      throw new UnauthorizedException('Token is missing');
    }

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const session = await this.prisma.session.findFirst({
        where: {
          token,
          userId: payload['id'],
          isRevoked: false,
          expiresAt: { gt: new Date() },
        },
        include: { user: true },
      });

      if (!session) {
        throw new UnauthorizedException('Invalid session');
      }

      // Check if user status is still active (in case status changed after login)
      if (session.user.status !== 'active') {
        throw new UnauthorizedException(
          'Your account status has changed. Please log in again.',
        );
      }

      req['user'] = session.user;
      req['sessionId'] = session.id;
      // IDs only: never attach email or name to telemetry.
      Sentry.setUser({ id: String(session.user.id) });
      Sentry.setTag('organization_id', session.user.organization_id);
      Sentry.setTag('role', session.user.role);
      return true;
    } catch (error) {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
