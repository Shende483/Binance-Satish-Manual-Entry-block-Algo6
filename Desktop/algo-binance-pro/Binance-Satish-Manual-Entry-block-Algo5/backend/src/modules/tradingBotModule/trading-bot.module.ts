
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ManualTradingBotService } from './trading-bot.service';

@Module({
  imports: [
  ],
  providers: [ManualTradingBotService],
  exports: [ManualTradingBotService],
})
export class TradingBotModule {}




