import { IsString, IsNotEmpty, MinLength } from 'class-validator';

export class LoginUserDto {
  @IsString()
  @IsNotEmpty()
  emailOrMobile: string;

  @IsString()
  @MinLength(6)
  password: string;
}