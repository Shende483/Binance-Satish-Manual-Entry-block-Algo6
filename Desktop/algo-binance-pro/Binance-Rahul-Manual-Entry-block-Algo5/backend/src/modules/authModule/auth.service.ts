import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtService } from '@nestjs/jwt';
import { User } from './user.schema';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginUserDto } from './dto/login-user.dto';

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private userModel: Model<User>,
    private jwtService: JwtService,
  ) {}

  async signUp(createUserDto: CreateUserDto) {
    const { email, mobile, password, firstName, lastName } = createUserDto;
    const existingUser = await this.userModel
      .findOne({ $or: [{ email }, { mobile }] })
      .exec();
    if (existingUser) {
      return { error: 'Email or mobile already exists' };
    }

    const user = new this.userModel({
      email,
      mobile,
      password,
      firstName,
      lastName,
    });
    await user.save();

    const payload = { id: user._id.toString(), email: user.email, mobile: user.mobile };
    const token = await this.jwtService.signAsync(payload);
    return { message: 'User created successfully', token };
  }

  async findUserByEmailOrMobile(loginUserDto: LoginUserDto) {
    const { emailOrMobile, password } = loginUserDto;
    const user = await this.userModel
      .findOne({ $or: [{ email: emailOrMobile }, { mobile: emailOrMobile }] })
      .exec();
    console.log("udfh", user);
    if (!user || user.password !== password) {
      console.log("invalid data", emailOrMobile, password);
      return { error: 'Invalid email/mobile or password' };
    }

    const payload = { id: user._id.toString(), email: user.email, mobile: user.mobile };
    const token = await this.jwtService.signAsync(payload);
    return { message: 'Login successful', token };
  }

  async verifyToken(token: string) {
    try {
      const payload = await this.jwtService.verifyAsync(token);
      const user = await this.userModel
        .findById(payload.id)
        .select('email mobile firstName lastName')
        .exec();
      if (!user) {
        throw new Error('User not found');
      }
      return { id: user._id.toString(), email: user.email, mobile: user.mobile, firstName: user.firstName, lastName: user.lastName };
    } catch (error) {
      throw new Error('Invalid or expired token');
    }
  }
}