
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ManualTradingBotService } from './trading-bot.service';
import { User, UserSchema } from '../authModule/user.schema';
import { Trade, TradeSchema } from './trade.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Trade.name, schema: TradeSchema },
    ]),
  ],
  providers: [ManualTradingBotService],
  exports: [ManualTradingBotService],
})
export class TradingBotModule {}




