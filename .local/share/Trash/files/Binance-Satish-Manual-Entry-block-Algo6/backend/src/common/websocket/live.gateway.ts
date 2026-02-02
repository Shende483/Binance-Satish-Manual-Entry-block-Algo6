


// src/gateway/manual-live.gateway.ts
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
      console.log(`Client connecting: ${client.id} with accountId: ${accountId}`);
      if (!token || !accountId) {
        client.emit('auth-error', { statusCode: 301, message: 'Token and accountId required', success: false });
        return client.disconnect();
      }
      if (!timestamp || Math.abs(Date.now() - new Date(timestamp).getTime()) / 1000 > 5) {
        client.emit('auth-error', { statusCode: 305, message: 'Timestamp invalid', success: false });
        return client.disconnect();
      }
      const canActivate = await this.wsAuthGuard.canActivate({
        switchToWs: () => ({ getClient: () => client }),
      } as any);
      if (!canActivate) return client.disconnect();

      const user = client.data.user;
      client.data.accountId = accountId;
      const userId = user.userId;
      console.log(`Authenticated user: ${userId} for accountId: ${accountId}`);
      const room = `${userId}_${accountId}`;
      await this.manualTradingBotService.initUser(userId);
      client.join(room);
      await this.sendLiveData(room, userId, accountId);
    } catch (err) {
      client.emit('auth-error', { statusCode: 303, message: err.message, success: false });
      client.disconnect();
    }
  }

  handleDisconnect(@ConnectedSocket() client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  // REFRESH DATA — NOW PROTECTED FROM SPAM
  @SubscribeMessage('refresh-data')
  async handleRefreshData(@ConnectedSocket() client: Socket) {
    if (client.data.isRefreshing) return;  // BLOCK DUPLICATE
    client.data.isRefreshing = true;

    const userId = client.data.user.userId;
    const accountId = client.data.accountId;
    const room = `${userId}_${accountId}`;

    try {
      await this.sendLiveData(room, userId, accountId);
    } finally {
      setTimeout(() => { client.data.isRefreshing = false; }, 1000); // allow next after 1 sec
    }
  }

  private async sendLiveData(room: string, userId: string, accountId: string) {
    try {
      this.manualTradingBotService.resetDailyCounters(userId);
      const balance = await this.manualTradingBotService.getUsdtBalance(userId);
      this.server.to(room).emit('equity-balance-manual', { accountId, equity: balance, balance });

      const positions = await this.manualTradingBotService.getOpenPositions(userId);
      const pending = await this.manualTradingBotService.getPendingOrders(userId);
     // console.log('Pending orders:', pending);
      const filteredPendingOrders = pending
        .filter(o => ['STOP_MARKET', 'TAKE_PROFIT_MARKET'].includes(o.orderType) && o.reduceOnly)
        .map(o => ({
          ClientId: o.clientAlgoId,
          orderId: o.algoId,
          type: o.orderType,
          symbol: o.symbol,
          side: o.side,
          positionSide: o.positionSide,
          time: o.updateTime,
          timeInForce: o.timeInForce,
          Qty: Number(o.quantity || 0),
          openPrice: Number(o.price || 0),
          stopLoss: o.triggerPrice,
        }));
//console.log('Filtered Pending Orders:', filteredPendingOrders);
      this.server.to(room).emit('live-data', {
        accountId,
        positionData: { positions, filteredPendingOrders },
      });

      const botStatus = this.manualTradingBotService.getBotStatus(userId);
      this.server.to(room).emit('bot-status', { accountId, ...botStatus });
    } catch (err) {
      console.error('Failed to send live data:', err);
    }
  }

  @SubscribeMessage('order-preflight')
  async handleOrderPreflight(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    if (client.data.isPreflighting) return client.emit('order-preflight-response', { error: 'Processing' });
    client.data.isPreflighting = true;

    const userId = client.data.user.userId;
    try {
      const { symbol, side, stopLoss, takeProfit, riskPercent, timestamp } = data;
    //  console.log('Received order-preflight data:', data);
      if (!symbol || !side || !stopLoss || !takeProfit || !timestamp) {
        throw new Error('Missing required fields');
      }
      if (Math.abs(Date.now() - new Date(timestamp).getTime()) / 1000 > 5) {
        throw new Error('Invalid timestamp');
      }
      const result = await this.manualTradingBotService.orderPreflight({
        userId,
        symbol,
        side: side.toUpperCase() as 'BUY' | 'SELL',
        stopLoss: Number(stopLoss),
        takeProfit: Number(takeProfit),
        riskPercent: riskPercent ? Number(riskPercent) : 0.4,
      });
      client.emit('order-preflight-response', { data: result });
    } catch (err: any) {
      client.emit('order-preflight-response', { error: err.message });
    } finally {
      client.data.isPreflighting = false;
    }
  }

  @SubscribeMessage('place-full-order')
  async handlePlaceFullOrder(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    if (client.data.isProcessingOrder) return client.emit('place-full-order-response', { error: 'Processing' });
    client.data.isProcessingOrder = true;

    const userId = client.data.user.userId;
    const accountId = client.data.accountId;
    const room = `${userId}_${accountId}`;

    try {
      const { symbol, side, stopLoss, takeProfit, riskPercent, timestamp, isScalping } = data;
    //  console.log('Received place-full-order data:', data);
      if (!timestamp || Math.abs(Date.now() - new Date(timestamp).getTime()) / 1000 > 5) {
        throw new Error('Invalid timestamp');
      }
      const result = await this.manualTradingBotService.placeFullOrder({
        userId,
        symbol,
        side: side.toUpperCase() as 'BUY' | 'SELL',
        type: 'MARKET',
        stopLoss: Number(stopLoss),
        takeProfit: Number(takeProfit),
        isScalping: Boolean(isScalping),
       riskPercent: riskPercent ? Number(riskPercent) : 0.4,
      });
      client.emit('place-full-order-response', { success: true, data: result });
      await this.sendLiveData(room, userId, accountId);
    } catch (err: any) {
      client.emit('place-full-order-response', { error: err.message });
    } finally {
      client.data.isProcessingOrder = false;
    }
  }

  @SubscribeMessage('close-position')
  async handleClosePosition(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    if (client.data.isProcessingClose) return client.emit('close-position-response', { error: 'Processing' });
    client.data.isProcessingClose = true;

    const userId = client.data.user.userId;
    const accountId = client.data.accountId;
    const room = `${userId}_${accountId}`;

    try {
      const { symbol, type, positionSide, volume, timestamp } = data;
      if (!timestamp || Math.abs(Date.now() - new Date(timestamp).getTime()) / 1000 > 5) {
        throw new Error('Invalid timestamp');
      }
      if (!volume || volume <= 0) throw new Error('Invalid volume');

      const closeSide = type === 'BUY' ? 'SELL' : 'BUY';
      const result = await this.manualTradingBotService.closePosition({
        userId,
        symbol,
        positionAmt: volume.toString(),
        mside: closeSide,
        positionSide: positionSide.toUpperCase() as 'LONG' | 'SHORT',
        updateTime: Date.now(),
      });
      client.emit('close-position-response', result);
      await this.sendLiveData(room, userId, accountId);
    } catch (err: any) {
      client.emit('close-position-response', { error: err.message });
    } finally {
      client.data.isProcessingClose = false;
    }
  }

  @SubscribeMessage('set-block-status')
  async handleSetBlockStatus(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    if (client.data.isSettingBlock) return client.emit('block-status-response', { error: 'Processing' });
    client.data.isSettingBlock = true;

    const userId = client.data.user.userId;
    const accountId = client.data.accountId;
    const room = `${userId}_${accountId}`;

    try {
      const { duration, timestamp } = data;
      if (!timestamp || Math.abs(Date.now() - new Date(timestamp).getTime()) / 1000 > 5) throw new Error('Invalid timestamp');
      const result = this.manualTradingBotService.activateRestingMode(userId, duration);
      client.emit('block-status-response', result);
      await this.sendLiveData(room, userId, accountId);
    } catch (err: any) {
      client.emit('block-status-response', { error: err.message });
    } finally {
      client.data.isSettingBlock = false;
    }
  }

  @SubscribeMessage('add-margin')
  async handleAddMargin(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    if (client.data.isAddingMargin) return client.emit('add-margin-response', { error: 'Processing' });
    client.data.isAddingMargin = true;

    const userId = client.data.user.userId;
    const accountId = client.data.accountId;
    const room = `${userId}_${accountId}`;

    try {
      const { symbol, side, amount, timestamp } = data;
      if (!timestamp || Math.abs(Date.now() - new Date(timestamp).getTime()) / 1000 > 5) throw new Error('Invalid timestamp');
      const result = await this.manualTradingBotService.addManualMargin({ userId, symbol, side, amount });
      client.emit('add-margin-response', result);
      await this.sendLiveData(room, userId, accountId);
    } catch (err: any) {
      client.emit('add-margin-response', { error: err.message });
    } finally {
      client.data.isAddingMargin = false;
    }
  }

  @SubscribeMessage('activate-burst')
  async handleActivateBurst(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    if (client.data.isActivatingBurst) return client.emit('burst-response', { error: 'Processing' });
    client.data.isActivatingBurst = true;

    const userId = client.data.user.userId;
    const accountId = client.data.accountId;
    const room = `${userId}_${accountId}`;

    try {
      if (!data.timestamp || Math.abs(Date.now() - new Date(data.timestamp).getTime()) / 1000 > 5) {
        throw new Error('Invalid timestamp');
      }
      const result = this.manualTradingBotService.activateBurstMode(userId);
      client.emit('burst-response', result);
      await this.sendLiveData(room, userId, accountId);
    } catch (err: any) {
      client.emit('burst-response', { success: false, reason: err.message });
    } finally {
      client.data.isActivatingBurst = false;
    }
  }

  @SubscribeMessage('deactivate-burst')
  async handleDeactivateBurst(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    if (client.data.isDeactivatingBurst) return client.emit('burst-response', { error: 'Processing' });
    client.data.isDeactivatingBurst = true;

    const userId = client.data.user.userId;
    const accountId = client.data.accountId;
    const room = `${userId}_${accountId}`;

    try {
      if (!data.timestamp || Math.abs(Date.now() - new Date(data.timestamp).getTime()) / 1000 > 5) {
        throw new Error('Invalid timestamp');
      }
      const result = this.manualTradingBotService.deactivateBurstMode(userId);
      client.emit('burst-response', result);
      await this.sendLiveData(room, userId, accountId);
    } catch (err: any) {
      client.emit('burst-response', { success: false, message: err.message });
    } finally {
      client.data.isDeactivatingBurst = false;
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

  @SubscribeMessage('modify-order')
  async handleModifyOrder(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    if (client.data.isModifyingOrder) return client.emit('modify-order-response', { error: 'Processing' });
    client.data.isModifyingOrder = true;

    const userId = client.data.user.userId;
    const accountId = client.data.accountId;
    const room = `${userId}_${accountId}`;

    try {
      const { timestamp, ...params } = data;
      if (!timestamp || Math.abs(Date.now() - new Date(timestamp).getTime()) / 1000 > 5) {
        throw new Error('Invalid timestamp');
      }
      await this.manualTradingBotService.modifyOrder({ userId, ...params });
      client.emit('modify-order-response', { success: true });
      await this.sendLiveData(room, userId, accountId);
    } catch (err: any) {
      client.emit('modify-order-response', { error: err.message });
    } finally {
      client.data.isModifyingOrder = false;
    }
  }
}



