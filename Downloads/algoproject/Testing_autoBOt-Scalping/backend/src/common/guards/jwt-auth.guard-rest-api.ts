import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const token = request.headers.authorization?.split(' ')[1];
    const timestamp = request.headers['x-request-timestamp'];

  //  console.log("🟢 Received Token:", token);
   // console.log("🟢 Received Timestamp:", timestamp);

    if (request.isProcessingAuth) {
      response.status(200).json({
        statusCode: 306,
        message: '❌ Authentication already in progress',
        success: false
      });
      return false;
    }

    request.isProcessingAuth = true;

    if (!token) {
      response.status(200).json({
        statusCode: 301,
        message: '❌ Token is required, Please login First...',
        success: false
      });
      request.isProcessingAuth = false;
      return false;
    }

    if (!timestamp) {
      response.status(200).json({
        statusCode: 304,
        message: 'Slow Network, Check your Network Connection',
        success: false
      });
      request.isProcessingAuth = false;
      return false;
    }

    const requestTime = new Date(timestamp);
    const currentTime = new Date();
    const timeDiff = (currentTime.getTime() - requestTime.getTime()) / 1000;

    if (timeDiff > 5) {
      response.status(200).json({
        statusCode: 305,
        message: '❌ Request timestamp is outside of allowed window',
        success: false
      });
      request.isProcessingAuth = false;
      return false;
    }

    try {
      const decoded = await this.jwtService.verifyAsync(token);

      if (!decoded) {
        response.status(200).json({
          statusCode: 302,
          message: '❌ Invalid token payload',
          success: false
        });
        request.isProcessingAuth = false;
        return false;
      }

    //  console.log("✅ Decoded Token:", decoded);
      request['user'] = {
        userId: decoded.id,
        email: decoded.email,
        mobile: decoded.mobile
      };

      request.isProcessingAuth = false;
      return true;
    } catch (error) {
      console.error("❌ Token Verification Error:", error.message);
      response.status(200).json({
        statusCode: 303,
        message: `❌ Token Verification Error: ${error.message}`,
        success: false
      });
      request.isProcessingAuth = false;
      return false;
    }
  }
}



/*

import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const token = request.headers.authorization?.split(' ')[1];
    const timestamp = request.headers['x-request-timestamp'];

    console.log("🟢 Received Token:", token);
    console.log("🟢 Received Timestamp:", timestamp);

    if (!token) {
      response.status(200).json({
        statusCode: 301,
        message: '❌ Token is required, Please login First...',
        success: false
      });
      return false;
    }



    if (!timestamp) {
      response.status(200).json({
        statusCode: 304,
        message: 'Slow Network, Check your Network Connection',
        success: false
      });
      return false;
    }

    const requestTime = new Date(timestamp);
    const currentTime = new Date();
    const timeDiff = (currentTime.getTime() - requestTime.getTime()) / 1000;

    if (timeDiff > 5) {
      response.status(200).json({
        statusCode: 305,
        message: '❌ Request timestamp is outside of allowed window',
        success: false
      });
      return false;
    }

    try {
      const decoded = await this.jwtService.verifyAsync(token);

      if (!decoded) {
        response.status(200).json({
          statusCode: 302,
          message: '❌ Invalid token payload',
          success: false
        });
        return false;
      }

      console.log("✅ Decoded Token:", decoded);
      request['user'] = {
        userId: decoded.id,
        email: decoded.email,
        mobile: decoded.mobile
      };

      return true;
    } catch (error) {
      console.error("❌ Token Verification Error:", error.message);
      response.status(200).json({
        statusCode: 303,
        message: `❌ Token Verification Error: ${error.message}`,
        success: false
      });
      return false;
    }
  }
}


*/



/*
import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    //this real ip is work when appplication is live , anyone sen dreq using postman then we get device ip and ntwrk isp ip 
   // by using this we use rate liming concept 
  //  const realip=request.Ip
    const response = context.switchToHttp().getResponse();
    const token = request.headers.authorization?.split(' ')[1];

    console.log("🟢 Received Token:", token); // Debug log to ensure token is received

    if (!token) {
      response.status(200).json({
        statusCode: 301,
        message: '❌ Token is required, Please login First...',
        success: false
      });
      return false; // Ensure `false` is returned for proper guard handling
    }

    try {
      const decoded = await this.jwtService.verifyAsync(token);

      if (!decoded) {
        response.status(200).json({
          statusCode: 302,
          message: '❌ Invalid token payload',
          success: false
        });
        return false;
      }

      console.log("✅ Decoded Token:", decoded); // Confirm token decoding success
      request['user'] = {
        userId: decoded.id,
        email: decoded.email,
        mobile:decoded.mobile
      };

      return true;
    } catch (error) {
      console.error("❌ Token Verification Error:", error.message); // Detailed error log
      response.status(200).json({
        statusCode: 303,
        message: `❌ Token Verification Error:", ${error.message}`,
        success: false
      });
      return false;
    }
  }
}
*/