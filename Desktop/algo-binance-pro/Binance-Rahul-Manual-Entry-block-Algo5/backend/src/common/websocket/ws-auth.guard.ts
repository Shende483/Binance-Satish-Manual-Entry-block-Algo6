import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Socket } from 'socket.io';

@Injectable()
export class WsAuthGuard implements CanActivate {
  private logger: Logger = new Logger('WsAuthGuard');

  constructor(private jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client: Socket = context.switchToWs().getClient();
    const token = client.handshake.auth?.token;

    this.logger.log(`🟢 Received Token: ${token}`);

    if (!token) {
      this.logger.error('❌ Token is required');
      client.emit('auth-error', {
        statusCode: 301,
        message: '❌ Token is required, Please login First...',
        success: false,
      });
      client.disconnect();
      return false;
    }

    try {
      const cleanToken = token.startsWith('Bearer ') ? token.slice(7) : token;
      const decoded = await this.jwtService.verifyAsync(cleanToken);

      if (!decoded || !decoded.id) {
        this.logger.error('❌ Invalid token payload');
        client.emit('auth-error', {
          statusCode: 302,
          message: '❌ Invalid token payload',
          success: false,
        });
        client.disconnect();
        return false;
      }

     // this.logger.log(`✅ Decoded Token: userId=${decoded.id}, email=${decoded.email}, mobile=${decoded.mobile}`);
      client.data.user = {
        userId: decoded.id,
        email: decoded.email,
        mobile: decoded.mobile,
      };

      return true;
    } catch (error) {
      this.logger.error(`❌ Token Verification Error: ${error.message}`);
      client.emit('auth-error', {
        statusCode: 303,
        message: `❌ Token Verification Error: ${error.message}`,
        success: false,
      });
      client.disconnect();
      return false;
    }
  }

  async validateToken(token: string) {
    if (!token) {
      this.logger.error('❌ No token provided');
      return null;
    }

    const cleanToken = token.startsWith('Bearer ') ? token.slice(7) : token;

    try {
      const payload = await this.jwtService.verifyAsync(cleanToken);
      if (!payload || !payload.id) {
        this.logger.error('❌ Invalid token payload');
        return null;
      }
     // this.logger.log(`✅ Token verified: userId=${payload.id}, email=${payload.email}, mobile=${payload.mobile}`);
      return {
        userId: payload.id,
        email: payload.email,
        mobile: payload.mobile,
      };
    } catch (error) {
      this.logger.error(`❌ Invalid token: ${error.message}`);
      return null;
    }
  }
}