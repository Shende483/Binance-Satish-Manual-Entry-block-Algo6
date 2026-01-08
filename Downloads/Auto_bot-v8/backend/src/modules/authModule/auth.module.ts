import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { User, UserSchema } from './user.schema';
import jwtConfing from 'src/config/jwt.confing';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
     JwtModule.registerAsync(jwtConfing.asProvider()),
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}