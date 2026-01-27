import { Module } from '@nestjs/common';
import { ManualLiveGateway } from './live.gateway';
import { SocketService } from './socket.service';
import { WsAuthGuard } from './ws-auth.guard';
import { JwtModule } from '@nestjs/jwt';
import { TradingBotModule } from 'src/modules/tradingBotModule/trading-bot.module';
import jwtConfing from 'src/config/jwt.confing';


@Module({
  imports: [
   JwtModule.registerAsync(jwtConfing.asProvider()),
    TradingBotModule, // Import TradingBotModule
  ],
  providers: [
    SocketService,
    ManualLiveGateway,
    WsAuthGuard,
  ],
  exports: [SocketService],
})
export class WebsocketModule {}





