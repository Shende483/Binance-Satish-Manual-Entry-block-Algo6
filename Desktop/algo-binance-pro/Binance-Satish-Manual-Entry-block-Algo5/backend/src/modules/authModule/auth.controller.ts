import { Controller, Post, Body, HttpException, HttpStatus, Get, Req } from '@nestjs/common';
import { AuthService } from './auth.service';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginUserDto } from './dto/login-user.dto';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('signup')
  async signUp(@Body() createUserDto: CreateUserDto) {
    const result = await this.authService.signUp(createUserDto);
    if ('error' in result) {
      throw new HttpException(result, HttpStatus.BAD_REQUEST);
    }
    return { message: 'Signup successful', token: result.token };
  }

  @Post('login')
  async login(@Body() loginUserDto: LoginUserDto) {
    const { emailOrMobile, password } = loginUserDto;
    const result = await this.authService.findUserByEmailOrMobile(loginUserDto);
    console.log("fjjfjjf", emailOrMobile, password);
    if ('error' in result) {
      throw new HttpException('Invalid credentials', HttpStatus.UNAUTHORIZED);
    }
    return { message: 'Login successful', token: result.token };
  }

  @Get('verify-token')
  async verifyToken(@Req() request: any) {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new HttpException('No token provided', HttpStatus.UNAUTHORIZED);
    }
    const token = authHeader.split(' ')[1];
    try {
      const result = await this.authService.verifyToken(token);
      return { message: 'Token is valid', user: result };
    } catch (error) {
      throw new HttpException('Invalid or expired token', HttpStatus.UNAUTHORIZED);
    }
  }
}