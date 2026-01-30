
import { JwtModuleOptions } from '@nestjs/jwt';
import { registerAs } from '@nestjs/config';

export default registerAs('jwt', (): JwtModuleOptions => ({
  secret: process.env.JWT_SECRET ,
  signOptions: {
    expiresIn: process.env.JWT_EXPIRES_IN
      ? (isNaN(Number(process.env.JWT_EXPIRES_IN)) ? process.env.JWT_EXPIRES_IN : Number(process.env.JWT_EXPIRES_IN))
      : undefined,
  } as any,
}));

