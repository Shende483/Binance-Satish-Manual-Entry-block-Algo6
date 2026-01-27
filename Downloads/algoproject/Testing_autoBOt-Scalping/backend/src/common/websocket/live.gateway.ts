



import { Logger } from '@nestjs/common';
import {
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { WsAuthGuard } from './ws-auth.guard';
import { ManualTradingBotService } from 'src/modules/tradingBotModule/trading-bot.service';

@WebSocketGateway({ cors: { origin: '*', credentials: true } })
export class ManualLiveGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private logger: Logger = new Logger('ManualLiveGateway');

  constructor(
    private readonly wsAuthGuard: WsAuthGuard,
    private readonly manualTradingBotService: ManualTradingBotService,
  ) {}

  afterInit() {
    this.manualTradingBotService.setSocketServer?.(this.server);
  }
async handleConnection(@ConnectedSocket() client: Socket) {
    try {
      const { token, accountId, timestamp } = client.handshake.auth;
      if (!token || !accountId) {
        client.emit('auth-error', { message: 'Token and accountId required' });
        return client.disconnect();
      }
      if (!timestamp || Math.abs(Date.now() - new Date(timestamp).getTime()) / 1000 > 5) {
        client.emit('auth-error', { message: 'Timestamp invalid' });
        return client.disconnect();
      }
      const canActivate = await this.wsAuthGuard.canActivate({
        switchToWs: () => ({ getClient: () => client }),
      } as any);
      if (!canActivate) return client.disconnect();

      const userId = client.data.user.userId;
      client.data.accountId = accountId;
      const room = `${userId}_${accountId}`;
      client.join(room);

      await this.sendLiveData(room, userId);

      // Send initial trade history on connection
      try {
        const initialHistory = await this.manualTradingBotService.getTradeHistory(userId, 1, 10);
        client.emit('trade-history-response', initialHistory);
      //  console.log('Sent initial trade history to client:', initialHistory);
      } catch (err) {
        console.error('Failed to send initial history:', err);
      }
    } catch (err) {
      client.emit('auth-error', { message: err.message });
      client.disconnect();
    }
  }

  handleDisconnect(@ConnectedSocket() client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('refresh-data')
  async handleRefreshData(@ConnectedSocket() client: Socket) {
    if (client.data.isRefreshing) return;
    client.data.isRefreshing = true;
    const userId = client.data.user.userId;
    const accountId = client.data.accountId;
    const room = `${userId}_${accountId}`;
    try {
      await this.sendLiveData(room, userId);
    } finally {
      setTimeout(() => { client.data.isRefreshing = false; }, 1000);
    }
  }

  private async sendLiveData(room: string, userId: string) {
    try {
      const balance = await this.manualTradingBotService.getUsdtBalance(userId);
      this.server.to(room).emit('equity-balance-manual', { equity: balance, balance });

      const positions = Array.from(this.manualTradingBotService['virtualPositions'].values());
      const pending = Array.from(this.manualTradingBotService['virtualOrders'].values()).map(o => ({
        ClientId: o.clientAlgoId,
        type: o.type,
        symbol: o.symbol,
        side: o.side,
        positionSide: o.positionSide,
        Qty: o.quantity,
        stopLoss: o.triggerPrice,
      
      }));

      this.server.to(room).emit('live-data', { positionData: { positions, filteredPendingOrders: pending } });

      const botStatus = await this.manualTradingBotService.getBotStatus(userId);
      const todayEntries = await this.manualTradingBotService.getTodayEntries(userId);

      this.server.to(room).emit('bot-status', { ...botStatus, todayEntries });
    } catch (err) {
      console.error('Failed to send live data:', err);
    }
  }

  @SubscribeMessage('get-symbols')
  async handleGetSymbols(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    if (client.data.isGettingSymbols) return;
    client.data.isGettingSymbols = true;
    const userId = client.data.user.userId;
    try {
      if (!data.timestamp || Math.abs(Date.now() - new Date(data.timestamp).getTime()) / 1000 > 5) {
        throw new Error('Invalid timestamp');
      }
      const symbols = await this.manualTradingBotService.getUsdmSymbols(userId);
      client.emit('symbols-response', { symbols });
    } catch (err: any) {
      client.emit('symbols-response', { error: err.message });
    } finally {
      setTimeout(() => { client.data.isGettingSymbols = false; }, 2000);
    }
  }

  @SubscribeMessage('get-trade-history')
  async handleGetTradeHistory(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { page?: number; limit?: number; symbol?: string; timestamp: string },
  ) {
    if (client.data.isGettingHistory) return;
    client.data.isGettingHistory = true;
    const userId = client.data.user.userId;
    try {
      if (!data.timestamp || Math.abs(Date.now() - new Date(data.timestamp).getTime()) / 1000 > 5) {
        throw new Error('Invalid timestamp');
      }
      const page = data.page || 1;
      const limit = data.limit || 10;
      const symbol = data.symbol;
      const history = await this.manualTradingBotService.getTradeHistory(userId, page, limit, symbol);
      client.emit('trade-history-response', history);
    } catch (err: any) {
      client.emit('trade-history-response', { error: err.message });
    } finally {
      setTimeout(() => { client.data.isGettingHistory = false; }, 2000);
    }
  }

  @SubscribeMessage('get-symbol-today-entries')
  async handleSymbolTodayEntries(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { symbol: string; timestamp: string },
  ) {
    if (client.data.isGettingSymbolEntries) return;
    client.data.isGettingSymbolEntries = true;
    const userId = client.data.user.userId;
    try {
      if (!data.timestamp || Math.abs(Date.now() - new Date(data.timestamp).getTime()) / 1000 > 5) {
        throw new Error('Invalid timestamp');
      }
      const entries = await this.manualTradingBotService.getSymbolTodayEntries(userId, data.symbol);
      client.emit('symbol-today-entries-response', { symbol: data.symbol, entries });
    } catch (err: any) {
      client.emit('symbol-today-entries-response', { error: err.message });
    } finally {
      setTimeout(() => { client.data.isGettingSymbolEntries = false; }, 1000);
    }
  }
}






