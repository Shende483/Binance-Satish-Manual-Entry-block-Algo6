import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { WebsocketClient, USDMClient } from 'binance';
import { Server, DefaultEventsMap } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { User } from '../authModule/user.schema';
import { Trade } from './trade.schema';

interface UserBotState {
  dailyEntryCount: number;
  lastResetDate: Date | null;
  symbolEntryCounts: Map<string, number>;
}

@Injectable()
export class ManualTradingBotService implements OnModuleInit, OnModuleDestroy {
  private socketServer: Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>;
  setSocketServer(server: Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>) {
    this.socketServer = server;
  }
  private userStates = new Map<string, UserBotState>();
  private trailingState = new Map<string, {
    symbol: string;
    side: 'BUY' | 'SELL';
    positionSide: 'LONG' | 'SHORT' | 'BOTH';
    currentSL: number;
    currentTP: number;
    qty: string | number;
    trailCount: number;
    nextTriggerPrice: number;
    nextSL: number;
    nextTP: number;
    bigMoveTriggerPrice: number;
    bigMoveNextSL: number;
    bigMoveNextTP: number;
    slClientId: string;
    tpClientId: string;
    isScalping: boolean;
  }>();
  private candles1m: Record<string, any[]> = {};
  private virtualMode = true;
  private virtualPositions = new Map<string, {
    symbol: string;
    side: 'BUY' | 'SELL';
    qty: number;
    entryPrice: number;
    allocatedMargin: number;
    leverage: number;
    positionSide: 'LONG' | 'SHORT';
    entryTime: Date;
    riskAmount: number;
    patternType: 'HAMMER' | 'INVERSE_HAMMER' | 'BULLISH_ENGULFING' | 'BEARISH_ENGULFING' | 'BULLISH_HARAMI' | 'BEARISH_HARAMI' | 'BULLISH_SPINNING_TOP' | 'BEARISH_SPINNING_TOP'|'BULLISH_INSIDE_BAR' | 'BEARISH_INSIDE_BAR';
    historyCheckCandles?: number;
    volumeTimeframe?: string; // NEW
  }>();
  private virtualOrders = new Map<string, {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    triggerPrice: number;
    quantity: number;
    positionSide: 'LONG' | 'SHORT';
    workingType: 'MARK_PRICE';
    clientAlgoId: string
  }>();
  private currentMarkPrices = new Map<string, number>();
  private publicRest = new USDMClient();
  private readonly API_KEY = 'anxHzhKimGJfF2Y8HwPJAn4sVc6MP0mgcuq4jOrfzlvfh3wDfWgIOqKKOU62uqAT';
  private readonly API_SECRET = '6jlQHBKWEwi2ZhwCHw5kxsqJDF9SDDaL2HuSiG964sqxPYpPSE6EIda1Gl4uFp23';
  private publicWS = new WebsocketClient({
    api_key: this.API_KEY,
    api_secret: this.API_SECRET,
    beautify: true,
  });
  private readonly OUR_CLIENT_PREFIX = 'x-15PC4ZJy_Xcdr';
  private readonly COMMISSION_RATE = 0.0004;
  private readonly MAX_RANGE_PERCENT = 0.005;
  constructor(
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Trade.name) private tradeModel: Model<Trade>,
  ) {}

  private async getSymbolPrecision(symbol: string) {
    const info = await this.publicRest.getExchangeInfo();
    const s = info.symbols.find((x: any) => x.symbol === symbol);
    if (!s) throw new Error(`Symbol ${symbol} not found`);
    return { pricePrecision: s.pricePrecision, qtyPrecision: s.quantityPrecision };
  }
  private round(value: number, precision: number): number {
    if (precision === 0) return Math.round(value);
    const factor = Math.pow(10, precision);
    return Math.round(value * factor) / factor;
  }
  private getIntervalMs(interval: string): number {
    if (interval === '1d') return 24 * 60 * 60 * 1000;
    const hours = parseInt(interval.replace('h', ''));
    return hours * 60 * 60 * 1000;
  }

  // CHANGED: returns timeframe string or null
  private async checkVolumeIncrease(symbol: string): Promise<string | null> {
    const intervals = ['1d', '12h', '6h', '4h', '2h', '1h'];
    for (const interval of intervals) {
      const now = new Date().getTime();
      const intervalMs = this.getIntervalMs(interval);
      const currentCandleStart = Math.floor(now / intervalMs) * intervalMs;
      const endTime = currentCandleStart - 1;
      try {
        const historical = await this.publicRest.getKlines({
          symbol,
          interval: interval as any,
          limit: 2,
          endTime
        });
        if (historical.length < 2) continue;
        const vol1 = Number(historical[0][5]);
        const vol2 = Number(historical[1][5]);
        if (vol2 > vol1) return interval;
      } catch (e) {
        console.error(`Failed to fetch ${interval} klines for volume check on ${symbol}:`, e);
        continue;
      }
    }
    return null;
  }
  
  async onModuleInit() {
    const users = ['68c6276c227c0a83f0f3823d'];
    for (const userId of users) {
      this.userStates.set(userId, {
        dailyEntryCount: 0,
        lastResetDate: null,
        symbolEntryCounts: new Map<string, number>(),
      });
    }
    this.publicWS.on('formattedMessage', (data: any) => {
      const updates = Array.isArray(data) ? data : [data];
      for (const update of updates) {
        if (update.eventType === 'kline') this.handleKlineUpdate(update);
      }
    });
    const symbols = await this.getUsdmSymbols('68c6276c227c0a83f0f3823d');
    const limitedSymbols = symbols.slice(0, 400);
    for (const sym of limitedSymbols) {
      this.publicWS.subscribeKlines(sym.toLowerCase(), '1m', 'usdm');
    }
  }
  private handleKlineUpdate(update: any) {
    const kline = update.kline;
    const candle = {
      symbol: update.symbol,
      interval: kline.interval,
      startTime: kline.startTime,
      endTime: kline.endTime,
      open: Number(kline.open),
      close: Number(kline.close),
      high: Number(kline.high),
      low: Number(kline.low),
      volume: Number(kline.volume),
      quoteVolume: Number(kline.quoteVolume),
      trades: Number(kline.trades),
      volumeActive: Number(kline.volumeActive),
      quoteVolumeActive: Number(kline.quoteVolumeActive),
      isFinal: kline.final
    };
    if (candle.interval === '1m') {
      if (!this.candles1m[update.symbol]) this.candles1m[update.symbol] = [];
      const candles = this.candles1m[update.symbol];
      if (candles.length === 0 || candle.startTime > candles[candles.length - 1].startTime) candles.push(candle);
      else if (candles.length > 0 && candle.startTime === candles[candles.length - 1].startTime) candles[candles.length - 1] = candle;
      if (candles.length > 100) candles.shift();
      if (candles.length >= 3 && candles[candles.length - 1].isFinal) {
        this.checkForPatterns(update.symbol);
      }
    }
    const price = Number(update.kline.close);
    if (isNaN(price)) return;
    this.checkVirtualTriggers(update.symbol, price);
    for (const [posKey, pos] of this.virtualPositions.entries()) {
      if (pos.symbol !== update.symbol) continue;
      const trailing = [...this.trailingState.values()].find(t => t.symbol === pos.symbol && t.positionSide === pos.positionSide);
      const currentSL = trailing ? trailing.currentSL : 'N/A';
      const currentTP = trailing ? trailing.currentTP : 'N/A';
      const pnlSign = pos.side === 'BUY' ? 1 : -1;
      const unrealizedPnl = pos.qty * (price - pos.entryPrice) * pnlSign;
      const comm = pos.qty * (pos.entryPrice + price) * this.COMMISSION_RATE;
      const netUnrealized = unrealizedPnl - comm;
    }
    for (const [key, state] of this.trailingState.entries()) {
      if (state.symbol !== update.symbol) continue;
      const isLong = state.side === 'BUY';
         const bigTriggered = isLong ? price >= state.bigMoveTriggerPrice : price <= state.bigMoveTriggerPrice;
    const shouldTrigger = isLong ? price >= state.nextTriggerPrice : price <= state.nextTriggerPrice;
    if (bigTriggered) {
      this.executeTrail('68c6276c227c0a83f0f3823d', key, state, price);
    } else if (shouldTrigger) {
      this.executeTrail('68c6276c227c0a83f0f3823d', key, state, price);
    }
    }
    if (this.virtualPositions.size > 0) {
      this.emitLiveDataNow();
    }
  }
  private async checkVirtualTriggers(symbol: string, price: number) {
    for (const [clientAlgoId, order] of [...this.virtualOrders.entries()]) {
      if (order.symbol !== symbol) continue;
      let triggered = false;
      if (order.type === 'STOP_MARKET') triggered = order.side === 'SELL' ? price <= order.triggerPrice : price >= order.triggerPrice;
      else if (order.type === 'TAKE_PROFIT_MARKET') triggered = order.side === 'SELL' ? price >= order.triggerPrice : price <= order.triggerPrice;
      if (triggered) {
        const posKey = `${order.symbol}-${order.positionSide}`;
        const pos = this.virtualPositions.get(posKey);
        if (!pos) continue;
        const trailing = [...this.trailingState.values()].find(t => t.symbol === pos.symbol && t.positionSide === pos.positionSide);
        const currentSL = trailing ? trailing.currentSL : order.triggerPrice;
        const currentTP = trailing ? trailing.currentTP : order.triggerPrice;
        const pnlSign = pos.side === 'BUY' ? 1 : -1;
        const pnl = pos.qty * (price - pos.entryPrice) * pnlSign;
        const commOpen = pos.qty * pos.entryPrice * this.COMMISSION_RATE;
        const commClose = pos.qty * price * this.COMMISSION_RATE;
        const netPnl = pnl - commOpen - commClose;
        const user = await this.userModel.findById('68c6276c227c0a83f0f3823d');
        if (!user) throw new Error('User not found');
        user.balance += pos.allocatedMargin + netPnl;
        await user.save();
        const exitType = order.type === 'STOP_MARKET' ? 'SL' : 'TP';
        const trade = new this.tradeModel({
          userId: '68c6276c227c0a83f0f3823d',
          symbol: pos.symbol,
          side: pos.side,
          positionSide: pos.positionSide,
          entryPrice: pos.entryPrice,
          exitPrice: price,
          qty: pos.qty,
          sl: currentSL,
          tp: currentTP,
          pnl: netPnl,
          entryTime: pos.entryTime,
          exitTime: new Date(),
          isWin: netPnl > 0,
          exitType,
          leverage: pos.leverage,
          riskAmount: pos.riskAmount,
          allocatedMargin: pos.allocatedMargin,
          patternType: pos.patternType,
          historyCheckCandles: pos.historyCheckCandles,
          volumeTimeframe: pos.volumeTimeframe // NEW
        });
        await trade.save();
        this.virtualPositions.delete(posKey);
        this.virtualOrders.delete(clientAlgoId);
        const oppositeId = clientAlgoId.includes('_sl-') ? clientAlgoId.replace('_sl-', '_tp-') : clientAlgoId.replace('_tp-', '_sl-');
        this.virtualOrders.delete(oppositeId);
        for (const [key, state] of this.trailingState.entries()) {
          if (state.symbol === symbol && state.positionSide === order.positionSide) {
            this.trailingState.delete(key);
          }
        }
      }
    }
  }
  private async checkForPatterns(symbol: string) {
    const candles = this.candles1m[symbol] || [];
    if (candles.length < 3) return;
    const idx = candles.length - 1;
    const maxCandles = 1440;
    if (candles.length === 3) {
      const candle3 = candles[idx];
      const candle2 = candles[idx - 1];
      const candle1 = candles[idx - 2];
      if (this.isHammer(candle1)) {
        if ((candle1.high - candle1.low) / candle1.low > this.MAX_RANGE_PERCENT) return;
        if ((candle2.high - candle2.low) / candle2.low > this.MAX_RANGE_PERCENT) return;
        if ((candle3.high - candle3.low) / candle3.low > this.MAX_RANGE_PERCENT) return;
        if (candle2.low != candle2.open && candle2.close > candle1.high && candle3.high > candle2.high && candle3.low > candle2.low && candle2.low > candle1.low) {
          try {
            console.log(`Hammer detected on ${symbol} at ${new Date(candle1.startTime).toISOString()}`);
            const historical = await this.publicRest.getKlines({
              symbol,
              interval: '1m',
              limit: maxCandles,
              endTime: candle1.startTime - 1
            });
            const prev = historical.map((k: any) => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const checkWindows = [1440, 720, 240, 180, 120, 60];
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const minLow = Math.min(...checkPrev.map((c: any) => c.low));
              if (minLow > candle1.low) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (volumeTf) {
                  const sl = candle1.low;
                  const tp = candle3.close + 5 * (candle3.close - sl);
                  try {
                    this.placeFullOrder({
                      userId: '68c6276c227c0a83f0f3823d',
                      symbol,
                      side: 'BUY',
                      type: 'MARKET',
                      stopLoss: sl,
                      takeProfit: tp,
                      isScalping: true,
                      patternType: 'HAMMER',
                      historyCheckCandles: numCandles,
                      volumeTimeframe: volumeTf
                    });
                    console.log(`HAMMER LONG detected and entered: ${symbol} (volume TF: ${volumeTf})`);
                    return;
                  } catch (error) {}
                }
              }
            }
          } catch (e) {
            console.error(`Failed to fetch historical klines for ${symbol}:`, e);
          }
        }
      }
      if (this.isInverseHammer(candle1)) {
        if ((candle1.high - candle1.low) / candle1.low > this.MAX_RANGE_PERCENT) return;
        if ((candle2.high - candle2.low) / candle2.low > this.MAX_RANGE_PERCENT) return;
        if ((candle3.high - candle3.low) / candle3.low > this.MAX_RANGE_PERCENT) return;
        if (candle2.high != candle2.open && candle2.close < candle1.low && candle3.low < candle2.low && candle3.high < candle2.high && candle2.high < candle1.high) {
          try {
            console.log(`Inverse Hammer detected on ${symbol} at ${new Date(candle1.startTime).toISOString()}`);
            const historical = await this.publicRest.getKlines({
              symbol,
              interval: '1m',
              limit: maxCandles,
              endTime: candle1.startTime - 1
            });
            const prev = historical.map((k: any) => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const checkWindows = [1440, 720, 240, 180, 120, 60];
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const maxHigh = Math.max(...checkPrev.map((c: any) => c.high));
              if (maxHigh < candle1.high) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (volumeTf) {
                  const sl = candle1.high;
                  const tp = candle3.close - 5 * (sl - candle3.close);
                  try {
                    this.placeFullOrder({
                      userId: '68c6276c227c0a83f0f3823d',
                      symbol,
                      side: 'SELL',
                      type: 'MARKET',
                      stopLoss: sl,
                      takeProfit: tp,
                      isScalping: true,
                      patternType: 'INVERSE_HAMMER',
                      historyCheckCandles: numCandles,
                      volumeTimeframe: volumeTf
                    });
                    console.log(`INVERSE HAMMER SHORT detected and entered: ${symbol} (volume TF: ${volumeTf})`);
                    return;
                  } catch (error) {}
                }
              }
            }
          } catch (e) {
            console.error(`Failed to fetch historical klines for ${symbol}:`, e);
          }
        }
      }
      if (this.isBullishSpinningTop(candle1)) {
        if ((candle1.high - candle1.low) / candle1.low > this.MAX_RANGE_PERCENT) return;
        if ((candle2.high - candle2.low) / candle2.low > this.MAX_RANGE_PERCENT) return;
        if ((candle3.high - candle3.low) / candle3.low > this.MAX_RANGE_PERCENT) return;
        if (candle2.low != candle2.open && candle2.close > candle1.high && candle3.high > candle2.high && candle3.low > candle2.low && candle2.low > candle1.low) {
          try {
            const historical = await this.publicRest.getKlines({
              symbol,
              interval: '1m',
              limit: maxCandles,
              endTime: candle1.startTime - 1
            });
            const prev = historical.map((k: any) => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const checkWindows = [1440, 720, 240, 180, 120, 60];
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const minLow = Math.min(...checkPrev.map((c: any) => c.low));
              if (minLow > candle1.low) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (volumeTf) {
                  const sl = candle1.low;
                  const tp = candle3.close + 5 * (candle3.close - sl);
                  try {
                    this.placeFullOrder({
                      userId: '68c6276c227c0a83f0f3823d',
                      symbol,
                      side: 'BUY',
                      type: 'MARKET',
                      stopLoss: sl,
                      takeProfit: tp,
                      isScalping: true,
                      patternType: 'BULLISH_SPINNING_TOP',
                      historyCheckCandles: numCandles,
                      volumeTimeframe: volumeTf
                    });
                    console.log(`BULLISH SPINNING TOP LONG detected and entered: ${symbol} (volume TF: ${volumeTf})`);
                    return;
                  } catch (error) {}
                }
              }
            }
          } catch (e) {
            console.error(`Failed to fetch historical klines for ${symbol}:`, e);
          }
        }
      }
      if (this.isBearishSpinningTop(candle1)) {
        if ((candle1.high - candle1.low) / candle1.low > this.MAX_RANGE_PERCENT) return;
        if ((candle2.high - candle2.low) / candle2.low > this.MAX_RANGE_PERCENT) return;
        if ((candle3.high - candle3.low) / candle3.low > this.MAX_RANGE_PERCENT) return;
        if (candle2.high != candle2.open && candle2.close < candle1.low && candle3.low < candle2.low && candle3.high < candle2.high && candle2.high < candle1.high) {
          try {
            const historical = await this.publicRest.getKlines({
              symbol,
              interval: '1m',
              limit: maxCandles,
              endTime: candle1.startTime - 1
            });
            const prev = historical.map((k: any) => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const checkWindows = [1440, 720, 240, 180, 120, 60];
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const maxHigh = Math.max(...checkPrev.map((c: any) => c.high));
              if (maxHigh < candle1.high) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (volumeTf) {
                  const sl = candle1.high;
                  const tp = candle3.close - 5 * (sl - candle3.close);
                  try {
                    this.placeFullOrder({
                      userId: '68c6276c227c0a83f0f3823d',
                      symbol,
                      side: 'SELL',
                      type: 'MARKET',
                      stopLoss: sl,
                      takeProfit: tp,
                      isScalping: true,
                      patternType: 'BEARISH_SPINNING_TOP',
                      historyCheckCandles: numCandles,
                      volumeTimeframe: volumeTf
                    });
                    console.log(`BEARISH SPINNING TOP SHORT detected and entered: ${symbol} (volume TF: ${volumeTf})`);
                    return;
                  } catch (error) {}
                }
              }
            }
          } catch (e) {
            console.error(`Failed to fetch historical klines for ${symbol}:`, e);
          }
        }
      }
    } else {
      const candle4 = candles[idx];
      const candle3 = candles[idx - 1];
      const candle2 = candles[idx - 2];
      const candle1 = candles[idx - 3];
      if (candle4) {
        if ((candle1.high - candle1.low) / candle1.low > this.MAX_RANGE_PERCENT || (candle2.high - candle2.low) / candle2.low > this.MAX_RANGE_PERCENT) return;
        if ((candle3.high - candle3.low) / candle3.low > this.MAX_RANGE_PERCENT) return;
        if ((candle4.high - candle4.low) / candle4.low > this.MAX_RANGE_PERCENT) return;
        if (
         ( candle1.close < candle1.open && candle2.open <=candle1.close
          && candle2.low < candle1.low && candle2.high > candle1.high && candle2.close>candle1.open
        ) && (
          candle3.low > candle2.low && candle3.close > candle2.high && candle3.close > candle3.open && candle3.open !== candle3.low
        ) &&(candle4.high>candle3.high && candle4.low > candle3.low)
        ) {
          try {
            const historical = await this.publicRest.getKlines({
              symbol,
              interval: '1m',
              limit: maxCandles,
              endTime: candle2.startTime - 1
            });
            const prev = historical.map((k: any) => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const checkWindows = [1440, 720, 240, 180, 120, 60];
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const minLow = Math.min(...checkPrev.map((c: any) => c.low));
              const patternLow = Math.min(candle1.low, candle2.low);
              if (minLow > patternLow) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (volumeTf) {
                  const sl = candle2.low;
                  const tp = candle4.close + 5 * (candle4.close - sl);
                  try {
                    this.placeFullOrder({
                      userId: '68c6276c227c0a83f0f3823d',
                      symbol,
                      side: 'BUY',
                      type: 'MARKET',
                      stopLoss: sl,
                      takeProfit: tp,
                      isScalping: true,
                      patternType: 'BULLISH_ENGULFING',
                      historyCheckCandles: numCandles,
                      volumeTimeframe: volumeTf
                    });
                    console.log(`BULLISH ENGULFING LONG detected and entered: ${symbol} (volume TF: ${volumeTf})`);
                    return;
                  } catch (error) {}
                }
              }
            }
          } catch (e) {
            console.error(`Failed to fetch historical klines for ${symbol}:`, e);
          }
        }
      }
      if (candle4) {
        if ((candle1.high - candle1.low) / candle1.low > this.MAX_RANGE_PERCENT || (candle2.high - candle2.low) / candle2.low > this.MAX_RANGE_PERCENT) return;
        if ((candle3.high - candle3.low) / candle3.low > this.MAX_RANGE_PERCENT) return;
        if ((candle4.high - candle4.low) / candle4.low > this.MAX_RANGE_PERCENT) return;
       if (
         ( candle1.close > candle1.open && candle2.open >=candle1.close
          && candle2.low < candle1.low && candle2.high > candle1.high && candle2.close<candle1.open) &&
         (candle3.high < candle2.high && candle3.close < candle2.low && candle3.close < candle3.open && candle3.open !== candle3.high) &&
         (candle4.low < candle3.low && candle4.high < candle3.high)
        ) {
          try {
            const historical = await this.publicRest.getKlines({
              symbol,
              interval: '1m',
              limit: maxCandles,
              endTime: candle2.startTime - 1
            });
            const prev = historical.map((k: any) => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const checkWindows = [1440, 720, 240, 180, 120, 60];
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const maxHigh = Math.max(...checkPrev.map((c: any) => c.high));
              const patternHigh = Math.max(candle1.high, candle2.high);
              if (maxHigh < patternHigh) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (volumeTf) {
                  const sl = candle2.high;
                  const tp = candle4.close - 5 * (sl - candle4.close);
                  try {
                    this.placeFullOrder({
                      userId: '68c6276c227c0a83f0f3823d',
                      symbol,
                      side: 'SELL',
                      type: 'MARKET',
                      stopLoss: sl,
                      takeProfit: tp,
                      isScalping: true,
                      patternType: 'BEARISH_ENGULFING',
                      historyCheckCandles: numCandles,
                      volumeTimeframe: volumeTf
                    });
                    console.log(`BEARISH ENGULFING SHORT detected and entered: ${symbol} (volume TF: ${volumeTf})`);
                    return;
                  } catch (error) {}
                }
              }
            }
          } catch (e) {
            console.error(`Failed to fetch historical klines for ${symbol}:`, e);
          }
        }
      }
      if (candle4) {
        if ((candle1.high - candle1.low) / candle1.low > this.MAX_RANGE_PERCENT || (candle2.high - candle2.low) / candle2.low > this.MAX_RANGE_PERCENT) return;
        if ((candle3.high - candle3.low) / candle3.low > this.MAX_RANGE_PERCENT) return;
        if ((candle4.high - candle4.low) / candle4.low > this.MAX_RANGE_PERCENT) return;
      if (
        candle1.close < candle1.open && candle2.low >candle1.low && candle2.high <candle1.high && candle2.open >= candle1.close && candle2.close <= candle1.open && candle2.close > candle2.open &&
        candle3.close > candle3.open && candle3.close > candle1.high && candle3.low > candle2.low && candle3.open !== candle3.low &&
         candle4.high > candle3.high && candle4.low > candle3.low
         ) {
          try {
            const historical = await this.publicRest.getKlines({
              symbol,
              interval: '1m',
              limit: maxCandles,
              endTime: candle2.startTime - 1
            });
            const prev = historical.map((k: any) => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const checkWindows = [1440, 720, 240, 180, 120, 60];
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const minLow = Math.min(...checkPrev.map((c: any) => c.low));
              const patternLow = Math.min(candle1.low, candle2.low);
              if (minLow > patternLow) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (volumeTf) {
                  const sl = candle1.low
                  const tp = candle4.close + 5 * (candle4.close - sl);
                  try {
                    this.placeFullOrder({
                      userId: '68c6276c227c0a83f0f3823d',
                      symbol,
                      side: 'BUY',
                      type: 'MARKET',
                      stopLoss: sl,
                      takeProfit: tp,
                      isScalping: true,
                      patternType: 'BULLISH_HARAMI',
                      historyCheckCandles: numCandles,
                      volumeTimeframe: volumeTf
                    });
                    console.log(`BULLISH HARAMI LONG detected and entered: ${symbol} (volume TF: ${volumeTf})`);
                    return;
                  } catch (error) {}
                }
              }
            }
          } catch (e) {
            console.error(`Failed to fetch historical klines for ${symbol}:`, e);
          }
        }
      }
      if ( candle4) {
        if ((candle1.high - candle1.low) / candle1.low > this.MAX_RANGE_PERCENT || (candle2.high - candle2.low) / candle2.low > this.MAX_RANGE_PERCENT) return;
        if ((candle3.high - candle3.low) / candle3.low > this.MAX_RANGE_PERCENT) return;
        if ((candle4.high - candle4.low) / candle4.low > this.MAX_RANGE_PERCENT) return;
      if (
    candle1.close > candle1.open && candle2.low >candle1.low && candle2.high <candle1.high && candle2.open <= candle1.close && candle2.close >= candle1.open && candle2.close < candle2.open &&
        candle3.close < candle3.open && candle3.close < candle1.low && candle3.high < candle2.high && candle3.open !== candle3.high &&
         candle4.low < candle3.low && candle4.high < candle3.high
  ) {
          try {
            const historical = await this.publicRest.getKlines({
              symbol,
              interval: '1m',
              limit: maxCandles,
              endTime: candle2.startTime - 1
            });
            const prev = historical.map((k: any) => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const checkWindows = [1440, 720, 240, 180, 120, 60];
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const maxHigh = Math.max(...checkPrev.map((c: any) => c.high));
              const patternHigh = Math.max(candle1.high, candle2.high);
              if (maxHigh < patternHigh) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (volumeTf) {
                  const sl = candle1.high;
                  const tp = candle4.close - 5 * (sl - candle4.close);
                  try {
                    this.placeFullOrder({
                      userId: '68c6276c227c0a83f0f3823d',
                      symbol,
                      side: 'SELL',
                      type: 'MARKET',
                      stopLoss: sl,
                      takeProfit: tp,
                      isScalping: true,
                      patternType: 'BEARISH_HARAMI',
                      historyCheckCandles: numCandles,
                      volumeTimeframe: volumeTf
                    });
                    console.log(`BEARISH HARAMI SHORT detected and entered: ${symbol} (volume TF: ${volumeTf})`);
                    return;
                  } catch (error) {}
                }
              }
            }
          } catch (e) {
            console.error(`Failed to fetch historical klines for ${symbol}:`, e);
          }
        }
      }
      for (let numInside = 5; numInside >= 1; numInside--) {
        const motherIndex = idx - (numInside + 2);
        if (motherIndex < 0) continue;
        const mother = candles[motherIndex];
        let allInside = true;
        for (let i = 1; i <= numInside; i++) {
          const insideC = candles[motherIndex + i];
          if (!(insideC.high <= mother.high && insideC.low >= mother.low)) {
            allInside = false;
            break;
          }
        }
        if (!allInside) continue;
        const breakout = candles[idx - 1];
        const confirm = candles[idx];
        let maxRangeExceeded = false;
        for (let i = 0; i <= numInside + 2; i++) {
          const c = candles[motherIndex + i];
          if ((c.high - c.low) / c.low > this.MAX_RANGE_PERCENT) {
            maxRangeExceeded = true;
            break;
          }
        }
        if (maxRangeExceeded) continue;
        if (
          (mother.close < mother.open) &&
          (breakout.close > mother.high && breakout.low > mother.low && breakout.close > breakout.open && breakout.open !== breakout.low) &&
          (confirm.high > breakout.high && confirm.low > breakout.low)
        ) {
          try {
            const historical = await this.publicRest.getKlines({
              symbol,
              interval: '1m',
              limit: maxCandles,
              endTime: mother.startTime - 1
            });
            const prev = historical.map((k: any) => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const checkWindows = [1440, 720, 240, 180, 120, 60];
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const minLow = Math.min(...checkPrev.map((c: any) => c.low));
              const patternLow = mother.low;
              if (minLow > patternLow) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (volumeTf) {
                  const sl = patternLow;
                  const tp = confirm.close + 5 * (confirm.close - sl);
                  try {
                    this.placeFullOrder({
                      userId: '68c6276c227c0a83f0f3823d',
                      symbol,
                      side: 'BUY',
                      type: 'MARKET',
                      stopLoss: sl,
                      takeProfit: tp,
                      isScalping: true,
                      patternType: 'BULLISH_INSIDE_BAR',
                      historyCheckCandles: numCandles,
                      volumeTimeframe: volumeTf
                    });
                    console.log(`BULLISH INSIDE BAR LONG detected and entered: ${symbol} (volume TF: ${volumeTf})`);
                    return;
                  } catch (error) {}
                }
              }
            }
          } catch (e) {
            console.error(`Failed to fetch historical klines for ${symbol}:`, e);
          }
        }
        if (
          (mother.close > mother.open) &&
          (breakout.close < mother.low && breakout.high <= mother.high && breakout.close < breakout.open && breakout.open !== breakout.high) &&
          (confirm.low < breakout.low && confirm.high < breakout.high)
        ) {
          try {
            const historical = await this.publicRest.getKlines({
              symbol,
              interval: '1m',
              limit: maxCandles,
              endTime: mother.startTime - 1
            });
            const prev = historical.map((k: any) => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const checkWindows = [1440, 720, 240, 180, 120, 60];
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const maxHigh = Math.max(...checkPrev.map((c: any) => c.high));
              const patternHigh = mother.high;
              if (maxHigh < patternHigh) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (volumeTf) {
                  const sl = patternHigh;
                  const tp = confirm.close - 5 * (sl - confirm.close);
                  try {
                    this.placeFullOrder({
                      userId: '68c6276c227c0a83f0f3823d',
                      symbol,
                      side: 'SELL',
                      type: 'MARKET',
                      stopLoss: sl,
                      takeProfit: tp,
                      isScalping: true,
                      patternType: 'BEARISH_INSIDE_BAR',
                      historyCheckCandles: numCandles,
                      volumeTimeframe: volumeTf
                    });
                    console.log(`BEARISH INSIDE BAR SHORT detected and entered: ${symbol} (volume TF: ${volumeTf})`);
                    return;
                  } catch (error) {}
                }
              }
            }
          } catch (e) {
            console.error(`Failed to fetch historical klines for ${symbol}:`, e);
          }
        }
      }
    }
  }
  private isHammer(c: any): boolean {
    const body = Math.abs(c.close - c.open);
    const lowerShadow = Math.min(c.open, c.close) - c.low;
    const upperShadow = c.high - Math.max(c.open, c.close);
    const range = c.high - c.low || 1e-8;
    return lowerShadow >= 2 * body && upperShadow <= 0.25 * Math.max(body, 1e-8) && lowerShadow / range >= 0.66 && c.close > c.open;
  }
  private isInverseHammer(c: any): boolean {
    const body = Math.abs(c.close - c.open);
    const upperShadow = c.high - Math.max(c.open, c.close);
    const lowerShadow = Math.min(c.open, c.close) - c.low;
    const range = c.high - c.low || 1e-8;
    return upperShadow >= 2 * body && lowerShadow <= 0.25 * Math.max(body, 1e-8) && upperShadow / range >= 0.66 && c.close < c.open;
  }
  isBullishSpinningTop(c: any): boolean {
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low || 1e-8;
    const upperShadow = c.high - Math.max(c.open, c.close);
    const lowerShadow = Math.min(c.open, c.close) - c.low;
    return body / range <= 0.3 && upperShadow >= body && lowerShadow >= body && c.close > c.open;
  }
  private isBearishSpinningTop(c: any): boolean {
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low || 1e-8;
    const upperShadow = c.high - Math.max(c.open, c.close);
    const lowerShadow = Math.min(c.open, c.close) - c.low;
    return body / range <= 0.3 && upperShadow >= body && lowerShadow >= body && c.close < c.open;
  }
  async onModuleDestroy() {}

  private async executeTrail(userId: string, key: string, state: any, currentPrice: number) {
    const oldkey = key;
    const symbol = state.symbol;
    const positionSide = state.positionSide;
    const qty = state.qty;
    const side = state.side;
    let oldSlExists = this.virtualOrders.has(state.slClientId);
    let oldTpExists = this.virtualOrders.has(state.tpClientId);
    if (!oldSlExists && !oldTpExists) {
      this.trailingState.delete(oldkey);
      return;
    }
    const precision = await this.getSymbolPrecision(symbol);
    const rootClientId = uuidv4().replace(/-/g, '').substring(0, 14);
    const newSlId = `${this.OUR_CLIENT_PREFIX}_sl-${rootClientId}`;
    const newTpId = `${this.OUR_CLIENT_PREFIX}_tp-${rootClientId}`;
    const isLong = side === 'BUY';
    const isBigMove = isLong ? currentPrice >= state.bigMoveTriggerPrice : currentPrice <= state.bigMoveTriggerPrice;
    const newSlTrigger = isBigMove ? state.bigMoveNextSL : state.nextSL;
    const newTpTrigger = isBigMove ? state.bigMoveNextTP : state.nextTP;
    const betterSL = isLong ? (newSlTrigger > state.currentSL) : (newSlTrigger < state.currentSL);
    const betterTP = isLong ? (newTpTrigger > state.currentTP) : (newTpTrigger < state.currentTP);
    if (betterSL && betterTP) {
      this.virtualOrders.set(newSlId, {
        symbol, side: side === 'BUY' ? 'SELL' : 'BUY', type: 'STOP_MARKET', triggerPrice: newSlTrigger,
        quantity: Number(qty), positionSide, workingType: 'MARK_PRICE', clientAlgoId: newSlId
      });
      this.virtualOrders.delete(state.slClientId);
      this.virtualOrders.set(newTpId, {
        symbol, side: side === 'BUY' ? 'SELL' : 'BUY', type: 'TAKE_PROFIT_MARKET', triggerPrice: newTpTrigger,
        quantity: Number(qty), positionSide, workingType: 'MARK_PRICE', clientAlgoId: newTpId
      });
      this.virtualOrders.delete(state.tpClientId);
      const newKey = `${userId}-${symbol}-${positionSide}-${side}-${newSlId}-${newTpId}`;
      let newNextTriggerPrice = state.nextTriggerPrice;
      let newNextSL = state.nextSL;
      let newNextTP = state.nextTP;
      let newBigMoveTriggerPrice = state.bigMoveTriggerPrice;
      let newBigMoveNextSL = state.bigMoveNextSL;
      let newBigMoveNextTP = state.bigMoveNextTP;
      if (isBigMove) {
        newNextTriggerPrice = this.round(isLong ? newSlTrigger * 1.10 : newSlTrigger / 1.10, precision.pricePrecision);
        newNextSL = this.round(isLong ? newSlTrigger * 1.03 : newSlTrigger / 1.03, precision.pricePrecision);
        newNextTP = this.round(isLong ? newTpTrigger * 1.03 : newTpTrigger / 1.03, precision.pricePrecision);
        newBigMoveTriggerPrice = this.round(isLong ? newSlTrigger * 1.36 : newSlTrigger / 1.36, precision.pricePrecision);
        newBigMoveNextSL = this.round(isLong ? newSlTrigger * 1.30 : newSlTrigger / 1.30, precision.pricePrecision);
        newBigMoveNextTP = this.round(isLong ? newTpTrigger * 1.30 : newTpTrigger / 1.30, precision.pricePrecision);
      } else {
        newNextTriggerPrice = this.round(isLong ? newSlTrigger * 1.10 : newSlTrigger / 1.10, precision.pricePrecision);
        newNextSL = this.round(isLong ? newSlTrigger * 1.03 : newSlTrigger / 1.03, precision.pricePrecision);
        newNextTP = this.round(isLong ? newTpTrigger * 1.03 : newTpTrigger / 1.03, precision.pricePrecision);
      }
      this.trailingState.set(newKey, {
        ...state,
        currentSL: newSlTrigger,
        currentTP: newTpTrigger,
        trailCount: state.trailCount + 1,
        nextTriggerPrice: newNextTriggerPrice,
        nextSL: newNextSL,
        nextTP: newNextTP,
        bigMoveTriggerPrice: newBigMoveTriggerPrice,
        bigMoveNextSL: newBigMoveNextSL,
        bigMoveNextTP: newBigMoveNextTP,
        slClientId: newSlId,
        tpClientId: newTpId
      });
      this.trailingState.delete(oldkey);
    } else {
      if (isBigMove) {
        state.nextTriggerPrice = this.round(isLong ? state.currentSL * 1.10 : state.currentSL / 1.10, precision.pricePrecision);
        state.nextSL = this.round(isLong ? state.currentSL * 1.03 : state.currentSL / 1.03, precision.pricePrecision);
        state.nextTP = this.round(isLong ? state.currentTP * 1.03 : state.currentTP / 1.03, precision.pricePrecision);
        state.bigMoveTriggerPrice = this.round(isLong ? state.currentSL * 1.36 : state.currentSL / 1.36, precision.pricePrecision);
        state.bigMoveNextSL = this.round(isLong ? state.currentSL * 1.30 : state.currentSL / 1.30, precision.pricePrecision);
        state.bigMoveNextTP = this.round(isLong ? state.currentTP * 1.30 : state.currentTP / 1.30, precision.pricePrecision);
      } else {
        state.nextTriggerPrice = this.round(isLong ? state.currentSL * 1.10 : state.currentSL / 1.10, precision.pricePrecision);
        state.nextSL = this.round(isLong ? state.currentSL * 1.03 : state.currentSL / 1.03, precision.pricePrecision);
        state.nextTP = this.round(isLong ? state.currentTP * 1.03 : state.currentTP / 1.03, precision.pricePrecision);
      }
    }
  }

  private resetDailyCounters(userId: string) {
    const state = this.getUserState(userId);
    const now = new Date();
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const istTime = new Date(now.getTime() + IST_OFFSET_MS);
    const todayIST = new Date(istTime.getUTCFullYear(), istTime.getUTCMonth(), istTime.getUTCDate());
    if (!state.lastResetDate || state.lastResetDate < todayIST) {
      state.dailyEntryCount = 0;
      state.symbolEntryCounts.clear();
      state.lastResetDate = todayIST;
    }
  }

  private canPlaceEntry(userId: string): { allowed: boolean; reason?: string } {
    this.resetDailyCounters(userId);
    const state = this.getUserState(userId);
    const now = new Date();
    const hoursUTC = now.getUTCHours();
    const minutesUTC = now.getUTCMinutes();
    const currentMinutes = hoursUTC * 60 + minutesUTC;
    const banStart = 3 * 60 + 30;
   // const banEnd = 17 * 60 + 30;
  const banEnd = 3 * 60 + 30;
    if (currentMinutes >= banStart && currentMinutes < banEnd) {
      return { allowed: false, reason: 'Entries banned during 03:30-17:30 UTC (9 AM-11 PM IST)' };
    }
    if (state.dailyEntryCount >= 900) return { allowed: false, reason: 'Max 90 entries/day reached' };
    return { allowed: true };
  }

  private canEnterSymbolSide(userId: string, symbol: string, positionSide: 'LONG' | 'SHORT'): { allowed: boolean; reason?: string } {
    const state = this.getUserState(userId);
    const key = `${symbol}-${positionSide}`;
    const count = state.symbolEntryCounts.get(key) || 0;
    if (count >= 3) return { allowed: false, reason: `Max 3 entries/day for ${symbol} ${positionSide}` };
    return { allowed: true };
  }

  async placeFullOrder(params: {
    userId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'MARKET';
    stopLoss: number;
    takeProfit: number;
    isScalping?: boolean;
    patternType: 'HAMMER' | 'INVERSE_HAMMER' | 'BULLISH_ENGULFING' | 'BEARISH_ENGULFING' | 'BULLISH_HARAMI' | 'BEARISH_HARAMI' | 'BULLISH_SPINNING_TOP' | 'BEARISH_SPINNING_TOP' | 'BULLISH_INSIDE_BAR' | 'BEARISH_INSIDE_BAR';
    historyCheckCandles?: number;
    volumeTimeframe?: string; // NEW
  }) {
    const { userId, symbol, side, stopLoss, takeProfit, isScalping = false, patternType, historyCheckCandles, volumeTimeframe } = params;
    const state = this.getUserState(userId);
    const canEnter = this.canPlaceEntry(userId);
    if (!canEnter.allowed) throw new Error(`ENTRY BLOCKED: ${canEnter.reason}`);
    const targetPositionSide = side === 'BUY' ? 'LONG' : 'SHORT';
    const symbolLimit = this.canEnterSymbolSide(userId, symbol, targetPositionSide);
    if (!symbolLimit.allowed) throw new Error(`ENTRY BLOCKED: ${symbolLimit.reason}`);


  const existingPosKey = `${symbol}-${targetPositionSide}`;
    if (this.virtualPositions.has(existingPosKey)) {
      throw new Error(`ENTRY BLOCKED: Position already running for ${symbol} ${targetPositionSide}`);
    }

    const precision = await this.getSymbolPrecision(symbol);
    const candles = this.candles1m[symbol] || [];
    if (candles.length === 0) throw new Error('No candle data for mark price');
    const latestCandle = candles[candles.length - 1];
    const markPrice = latestCandle.close;
    if (markPrice <= 0) throw new Error('No mark price');
    const priceDiff = Math.abs(markPrice - stopLoss);
    const riskAmount = 0.001 * (await this.getUsdtBalance(userId));
    const rawQty = riskAmount / priceDiff;
    const quantity = rawQty < 1 ? rawQty.toFixed(precision.qtyPrecision) : Math.round(rawQty).toString();
    const notional = parseFloat(quantity) * markPrice;
    if (notional < 5) throw new Error('Notional <5');
    const leverage = 20;
    const allocated = notional / leverage;
    const user = await this.userModel.findById(userId);
    if (!user) throw new Error('User not found');
    if (user.balance < allocated) throw new Error('Insufficient balance');
    user.balance -= allocated;
    await user.save();
    const posKey = `${symbol}-${targetPositionSide}`;
    this.virtualPositions.set(posKey, {
      symbol,
      side,
      qty: parseFloat(quantity),
      entryPrice: markPrice,
      allocatedMargin: allocated,
      leverage,
      positionSide: targetPositionSide,
      entryTime: new Date(),
      riskAmount,
      patternType,
      historyCheckCandles,
      volumeTimeframe
    });
    state.dailyEntryCount++;
    const symbolSideKey = `${symbol}-${targetPositionSide}`;
    state.symbolEntryCounts.set(symbolSideKey, (state.symbolEntryCounts.get(symbolSideKey) || 0) + 1);
    const rootClientId = uuidv4().replace(/-/g, '').substring(0, 14);
    const slClientId = `${this.OUR_CLIENT_PREFIX}_sl-${rootClientId}`;
    const tpClientId = `${this.OUR_CLIENT_PREFIX}_tp-${rootClientId}`;
    this.virtualOrders.set(slClientId, { symbol, side: side === 'BUY' ? 'SELL' : 'BUY', type: 'STOP_MARKET', triggerPrice: stopLoss, quantity: parseFloat(quantity), positionSide: targetPositionSide, workingType: 'MARK_PRICE', clientAlgoId: slClientId });
    this.virtualOrders.set(tpClientId, { symbol, side: side === 'BUY' ? 'SELL' : 'BUY', type: 'TAKE_PROFIT_MARKET', triggerPrice: takeProfit, quantity: parseFloat(quantity), positionSide: targetPositionSide, workingType: 'MARK_PRICE', clientAlgoId: tpClientId });
    const key = `${userId}-${symbol}-${targetPositionSide}-${side}-${slClientId}-${tpClientId}`;
    this.trailingState.set(key, {
      side, symbol, positionSide: targetPositionSide as any, currentSL: stopLoss, currentTP: takeProfit, qty: quantity, trailCount: 0, isScalping,
      nextTriggerPrice: this.round(side === 'BUY' ? stopLoss * 1.03 : stopLoss / 1.03, precision.pricePrecision),
      nextSL: this.round(side === 'BUY' ? stopLoss * 1.003 : stopLoss / 1.003, precision.pricePrecision),
      nextTP: this.round(side === 'BUY' ? takeProfit * 1.003 : takeProfit / 1.003, precision.pricePrecision),
      bigMoveTriggerPrice: this.round(side === 'BUY' ? stopLoss * 1.36 : stopLoss / 1.36, precision.pricePrecision),
      bigMoveNextSL: this.round(side === 'BUY' ? stopLoss * 1.30 : stopLoss / 1.30, precision.pricePrecision),
      bigMoveNextTP: this.round(side === 'BUY' ? takeProfit * 1.30 : takeProfit / 1.30, precision.pricePrecision),
      slClientId, tpClientId
    });
  //  console.log(`[${userId}] ENTRY ${side} ${symbol} ${targetPositionSide} | SL:${stopLoss} TP:${takeProfit}`);
   // console.log(`LIVE POSITION: ${side} ${symbol} ${targetPositionSide} | Qty: ${quantity} | Entry: ${markPrice} | SL: ${stopLoss} | TP: ${takeProfit} | Margin: ${allocated.toFixed(2)} USDT`);
  }

  private getUserState(userId: string): UserBotState {
    return this.userStates.get(userId)!;
  }

  public async getBotStatus(userId: string) {
    this.resetDailyCounters(userId);
    const state = this.getUserState(userId);
    const status = {
      dailyEntries: state.dailyEntryCount,
      maxDailyEntries: 900,
      virtualBalance: await this.getUsdtBalance(userId)
    };
    this.emitLiveDataNow(userId);
    return status;
  }

  async getUsdmSymbols(userId: string): Promise<string[]> {
    const info = await this.publicRest.getExchangeInfo();
    return info.symbols
      .filter((s: any) => s.contractType === 'PERPETUAL' && s.status === 'TRADING' && s.quoteAsset === 'USDT')
      .map((s: any) => s.symbol)
      .sort();
  }

  async getUsdtBalance(userId: string): Promise<number> {
    const user = await this.userModel.findById(userId);
    if (!user) throw new Error('User not found');
    return user.balance;
  }

  async getTradeStats(userId: string) {
    const trades = await this.tradeModel.find({ userId });
    const totalTrades = trades.length;
    const wins = trades.filter(t => t.isWin).length;
    const losses = totalTrades - wins;
    const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
    return { totalTrades, wins, losses, totalPnl };
  }

  async getTradeHistory(userId: string, page: number = 1, limit: number = 10, symbol?: string) {
    const skip = (page - 1) * limit;
    const query: any = { userId };
    if (symbol) query.symbol = symbol;
    const [trades, total] = await Promise.all([
      this.tradeModel
        .find(query)
        .sort({ exitTime: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.tradeModel.countDocuments(query).exec(),
    ]);
    return {
      trades,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getTodayEntries(userId: string) {
    const state = this.getUserState(userId);
    this.resetDailyCounters(userId);
    return state.dailyEntryCount;
  }

  async getSymbolTodayEntries(userId: string, symbol: string) {
    const state = this.getUserState(userId);
    const longKey = `${symbol}-LONG`;
    const shortKey = `${symbol}-SHORT`;
    return (state.symbolEntryCounts.get(longKey) || 0) + (state.symbolEntryCounts.get(shortKey) || 0);
  }

  private emitLiveDataNow(userId: string = '68c6276c227c0a83f0f3823d') {
    const positions = Array.from(this.virtualPositions.values()).map(pos => ({
      ...pos,
      currentPrice: this.candles1m[pos.symbol]?.[this.candles1m[pos.symbol].length - 1]?.close || pos.entryPrice,
      entryTime: pos.entryTime.toISOString()
    }));
    const filteredPendingOrders = Array.from(this.virtualOrders.values()).map(order => ({
      ClientId: order.clientAlgoId,
      type: order.type,
      symbol: order.symbol,
      side: order.side,
      positionSide: order.positionSide,
      Qty: order.quantity,
      stopLoss: order.triggerPrice
    }));
    const accountId = 'default';
    const room = `${userId}_${accountId}`;
    this.socketServer?.to(room).emit('live-data', { positionData: { positions, filteredPendingOrders } });
  }
}














/*
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { WebsocketClient, USDMClient } from 'binance';
import { Server, DefaultEventsMap } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { User } from '../authModule/user.schema';
import { Trade } from './trade.schema';

interface UserBotState {
  dailyEntryCount: number;
  lastResetDate: Date | null;
  symbolEntryCounts: Map<string, number>;
}

@Injectable()
export class ManualTradingBotService implements OnModuleInit, OnModuleDestroy {
  private socketServer: Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>;
  setSocketServer(server: Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>) {
    this.socketServer = server;
  }

  private userStates = new Map<string, UserBotState>();
  private trailingState = new Map<string, {
    symbol: string;
    side: 'BUY' | 'SELL';
    positionSide: 'LONG' | 'SHORT' | 'BOTH';
    currentSL: number;
    currentTP: number;
    qty: string | number;
    trailCount: number;
    nextTriggerPrice: number;
    nextSL: number;
    nextTP: number;
    bigMoveTriggerPrice: number;
    bigMoveNextSL: number;
    bigMoveNextTP: number;
    slClientId: string;
    tpClientId: string;
    isScalping: boolean;
  }>();
  private candles1m: Record<string, any[]> = {};
  private virtualMode = true;
  private virtualPositions = new Map<string, {
    symbol: string;
    side: 'BUY' | 'SELL';
    qty: number;
    entryPrice: number;
    allocatedMargin: number;
    leverage: number;
    positionSide: 'LONG' | 'SHORT';
    entryTime: Date;
    riskAmount: number;
    patternType: 'HAMMER' | 'INVERSE_HAMMER' | 'BULLISH_ENGULFING' | 'BEARISH_ENGULFING' | 'BULLISH_HARAMI' | 'BEARISH_HARAMI' | 'BULLISH_SPINNING_TOP' | 'BEARISH_SPINNING_TOP'|'BULLISH_INSIDE_BAR' | 'BEARISH_INSIDE_BAR';
    historyCheckCandles?: number;
  }>();
  private virtualOrders = new Map<string, {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    triggerPrice: number;
    quantity: number;
    positionSide: 'LONG' | 'SHORT';
    workingType: 'MARK_PRICE';
    clientAlgoId: string
  }>();
  private currentMarkPrices = new Map<string, number>();
  private publicRest = new USDMClient();
  private readonly API_KEY = 'anxHzhKimGJfF2Y8HwPJAn4sVc6MP0mgcuq4jOrfzlvfh3wDfWgIOqKKOU62uqAT';
  private readonly API_SECRET = '6jlQHBKWEwi2ZhwCHw5kxsqJDF9SDDaL2HuSiG964sqxPYpPSE6EIda1Gl4uFp23';
  private publicWS = new WebsocketClient({
    api_key: this.API_KEY,
    api_secret: this.API_SECRET,
    beautify: true,
  });
  private readonly OUR_CLIENT_PREFIX = 'x-15PC4ZJy_Xcdr';
  private readonly COMMISSION_RATE = 0.0004;
  private readonly MAX_RANGE_PERCENT = 0.005;

  constructor(
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Trade.name) private tradeModel: Model<Trade>,
  ) {}

  private async getSymbolPrecision(symbol: string) {
    const info = await this.publicRest.getExchangeInfo();
    const s = info.symbols.find((x: any) => x.symbol === symbol);
    if (!s) throw new Error(`Symbol ${symbol} not found`);
    return { pricePrecision: s.pricePrecision, qtyPrecision: s.quantityPrecision };
  }

  private round(value: number, precision: number): number {
    if (precision === 0) return Math.round(value);
    const factor = Math.pow(10, precision);
    return Math.round(value * factor) / factor;
  }

 private getIntervalMs(interval: string): number {
    if (interval === '1d') return 24 * 60 * 60 * 1000;
    const hours = parseInt(interval.replace('h', ''));
    return hours * 60 * 60 * 1000;
  }
  private async checkVolumeIncrease(symbol: string): Promise<boolean> {
    const intervals = ['1d', '12h', '6h', '4h', '2h', '1h'];
    for (const interval of intervals) {
      const now = new Date().getTime();
      const intervalMs = this.getIntervalMs(interval);
      const currentCandleStart = Math.floor(now / intervalMs) * intervalMs;
      const endTime = currentCandleStart - 1;
      try {
        const historical = await this.publicRest.getKlines({
          symbol,
          interval: interval as any,
          limit: 2,
          endTime
        });
        console.log("ghghghghghghghghghgh",historical)
        if (historical.length < 2) continue;
        const vol1 = Number(historical[0][5]);
        const vol2 = Number(historical[1][5]);
        console.log('ghhhhhhhhhhhhhhh',vol1,vol2)
        if (vol2 > vol1) return true;
      } catch (e) {
        console.error(`Failed to fetch ${interval} klines for volume check on ${symbol}:`, e);
        continue;
      }
    }
    return false;
  }
   

  async onModuleInit() {
    const users = ['68c6276c227c0a83f0f3823d'];
    for (const userId of users) {
      this.userStates.set(userId, {
        dailyEntryCount: 0,
        lastResetDate: null,
        symbolEntryCounts: new Map<string, number>(),
      });
    }
    this.publicWS.on('formattedMessage', (data: any) => {
      const updates = Array.isArray(data) ? data : [data];
      for (const update of updates) {
        if (update.eventType === 'kline') this.handleKlineUpdate(update);
      }
    });
    const symbols = await this.getUsdmSymbols('68c6276c227c0a83f0f3823d');
    const limitedSymbols = symbols.slice(0, 400);
    for (const sym of limitedSymbols) {
      this.publicWS.subscribeKlines(sym.toLowerCase(), '1m', 'usdm');
    }
  }

  private handleKlineUpdate(update: any) {
    const kline = update.kline;
    const candle = {
      symbol: update.symbol,
      interval: kline.interval,
      startTime: kline.startTime,
      endTime: kline.endTime,
      open: Number(kline.open),
      close: Number(kline.close),
      high: Number(kline.high),
      low: Number(kline.low),
      volume: Number(kline.volume),
      quoteVolume: Number(kline.quoteVolume),
      trades: Number(kline.trades),
      volumeActive: Number(kline.volumeActive),
      quoteVolumeActive: Number(kline.quoteVolumeActive),
      isFinal: kline.final
    };
    if (candle.interval === '1m') {
      if (!this.candles1m[update.symbol]) this.candles1m[update.symbol] = [];
      const candles = this.candles1m[update.symbol];
      if (candles.length === 0 || candle.startTime > candles[candles.length - 1].startTime) candles.push(candle);
      else if (candles.length > 0 && candle.startTime === candles[candles.length - 1].startTime) candles[candles.length - 1] = candle;
      if (candles.length > 100) candles.shift();
      if (candles.length >= 3 && candles[candles.length - 1].isFinal) {
        this.checkForPatterns(update.symbol);
      }
    }
    const price = Number(update.kline.close);
    if (isNaN(price)) return;
    this.checkVirtualTriggers(update.symbol, price);

    for (const [posKey, pos] of this.virtualPositions.entries()) {
      if (pos.symbol !== update.symbol) continue;
      const trailing = [...this.trailingState.values()].find(t => t.symbol === pos.symbol && t.positionSide === pos.positionSide);
      const currentSL = trailing ? trailing.currentSL : 'N/A';
      const currentTP = trailing ? trailing.currentTP : 'N/A';
      const pnlSign = pos.side === 'BUY' ? 1 : -1;
      const unrealizedPnl = pos.qty * (price - pos.entryPrice) * pnlSign;
      const comm = pos.qty * (pos.entryPrice + price) * this.COMMISSION_RATE;
      const netUnrealized = unrealizedPnl - comm;
    //  console.log(`LIVE PnL: ${pos.symbol} ${pos.positionSide} | Qty: ${pos.qty} | Entry: ${pos.entryPrice} | Mark: ${price.toFixed(2)} | SL: ${currentSL} | TP: ${currentTP} | Unrealized: ${netUnrealized.toFixed(2)} USDT`);
    }

    for (const [key, state] of this.trailingState.entries()) {
      if (state.symbol !== update.symbol) continue;
      const isLong = state.side === 'BUY';
      const bigTriggered = isLong ? price >= state.bigMoveTriggerPrice : price <= state.bigMoveTriggerPrice;
      if (bigTriggered) this.executeTrail('68c6276c227c0a83f0f3823d', key, state, price);
      const shouldTrigger = isLong ? price >= state.nextTriggerPrice : price <= state.nextTriggerPrice;
      if (shouldTrigger) this.executeTrail('68c6276c227c0a83f0f3823d', key, state, price);
    }

    if (this.virtualPositions.size > 0) {
      this.emitLiveDataNow();
    }
  }

  private async checkVirtualTriggers(symbol: string, price: number) {
    for (const [clientAlgoId, order] of [...this.virtualOrders.entries()]) {
      if (order.symbol !== symbol) continue;
      let triggered = false;
      if (order.type === 'STOP_MARKET') triggered = order.side === 'SELL' ? price <= order.triggerPrice : price >= order.triggerPrice;
      else if (order.type === 'TAKE_PROFIT_MARKET') triggered = order.side === 'SELL' ? price >= order.triggerPrice : price <= order.triggerPrice;
      if (triggered) {
        const posKey = `${order.symbol}-${order.positionSide}`;
        const pos = this.virtualPositions.get(posKey);
        if (!pos) continue;
        const trailing = [...this.trailingState.values()].find(t => t.symbol === pos.symbol && t.positionSide === pos.positionSide);
        const currentSL = trailing ? trailing.currentSL : order.triggerPrice;
        const currentTP = trailing ? trailing.currentTP : order.triggerPrice;
        const pnlSign = pos.side === 'BUY' ? 1 : -1;
        const pnl = pos.qty * (price - pos.entryPrice) * pnlSign;
        const commOpen = pos.qty * pos.entryPrice * this.COMMISSION_RATE;
        const commClose = pos.qty * price * this.COMMISSION_RATE;
        const netPnl = pnl - commOpen - commClose;
        const user = await this.userModel.findById('68c6276c227c0a83f0f3823d');
        if (!user) throw new Error('User not found');
        user.balance += pos.allocatedMargin + netPnl;
        await user.save();
      //  console.log(`POSITION CLOSED: ${pos.symbol} ${pos.positionSide} | Exit: ${price} | PnL: ${netPnl.toFixed(2)} USDT | New Balance: ${user.balance.toFixed(2)} USDT`);
        const exitType = order.type === 'STOP_MARKET' ? 'SL' : 'TP';
        const trade = new this.tradeModel({
          userId: '68c6276c227c0a83f0f3823d',
          symbol: pos.symbol,
          side: pos.side,
          positionSide: pos.positionSide,
          entryPrice: pos.entryPrice,
          exitPrice: price,
          qty: pos.qty,
          sl: currentSL,
          tp: currentTP,
          pnl: netPnl,
          entryTime: pos.entryTime,
          exitTime: new Date(),
          isWin: netPnl > 0,
          exitType,
          leverage: pos.leverage,
          riskAmount: pos.riskAmount,
          allocatedMargin: pos.allocatedMargin,
          patternType: pos.patternType,
          historyCheckCandles: pos.historyCheckCandles
        });
        await trade.save();
        this.virtualPositions.delete(posKey);
        this.virtualOrders.delete(clientAlgoId);
        const oppositeId = clientAlgoId.includes('_sl-') ? clientAlgoId.replace('_sl-', '_tp-') : clientAlgoId.replace('_tp-', '_sl-');
        this.virtualOrders.delete(oppositeId);
        for (const [key, state] of this.trailingState.entries()) {
          if (state.symbol === symbol && state.positionSide === order.positionSide) {
            this.trailingState.delete(key);
          }
        }
      }
    }
  }

  private async checkForPatterns(symbol: string) {
    const candles = this.candles1m[symbol] || [];
    if (candles.length < 3) return;
    const idx = candles.length - 1;
    const maxCandles = 1440;
    if (candles.length === 3) {
      const candle3 = candles[idx];
      const candle2 = candles[idx - 1];
      const candle1 = candles[idx - 2];
      if (this.isHammer(candle1)) {
        if ((candle1.high - candle1.low) / candle1.low > this.MAX_RANGE_PERCENT) return;
        if ((candle2.high - candle2.low) / candle2.low > this.MAX_RANGE_PERCENT) return;
        if ((candle3.high - candle3.low) / candle3.low > this.MAX_RANGE_PERCENT) return;
        if (candle2.low != candle2.open && candle2.close > candle1.high && candle3.high > candle2.high && candle3.low > candle2.low && candle2.low > candle1.low) {
          try {
            console.log(`Hammer detected on ${symbol} at ${new Date(candle1.startTime).toISOString()}`);
            const historical = await this.publicRest.getKlines({
              symbol,
              interval: '1m',
              limit: maxCandles,
              endTime: candle1.startTime - 1
            });
            const prev = historical.map(k => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const checkWindows = [1440, 720, 240, 180, 120, 60];
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const minLow = Math.min(...checkPrev.map(c => c.low));
              if (minLow > candle1.low) {
       if (await this.checkVolumeIncrease(symbol)) {
                const sl = candle1.low;
                const tp = candle3.close + 40 * (candle3.close - sl);
                try {
                this.placeFullOrder({
                  userId: '68c6276c227c0a83f0f3823d',
                  symbol,
                  side: 'BUY',
                  type: 'MARKET',
                  stopLoss: sl,
                  takeProfit: tp,
                  isScalping: true,
                  patternType: 'HAMMER',
                  historyCheckCandles: numCandles
                });
                console.log(`HAMMER LONG detected and entered: ${symbol}`);
                return;
 } catch (error) {
                  
                }
              }
              }
            }
          } catch (e) {
            console.error(`Failed to fetch historical klines for ${symbol}:`, e);
          }
        }
      }
      if (this.isInverseHammer(candle1)) {
        if ((candle1.high - candle1.low) / candle1.low > this.MAX_RANGE_PERCENT) return;
        if ((candle2.high - candle2.low) / candle2.low > this.MAX_RANGE_PERCENT) return;
        if ((candle3.high - candle3.low) / candle3.low > this.MAX_RANGE_PERCENT) return;
        if (candle2.high != candle2.open && candle2.close < candle1.low && candle3.low < candle2.low && candle3.high < candle2.high && candle2.high < candle1.high) {
          try {
           console.log(`Inverse Hammer detected on ${symbol} at ${new Date(candle1.startTime).toISOString()}`);
            const historical = await this.publicRest.getKlines({
              symbol,
              interval: '1m',
              limit: maxCandles,
              endTime: candle1.startTime - 1
            });
            const prev = historical.map(k => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const checkWindows = [1440, 720, 240, 180, 120, 60];
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const maxHigh = Math.max(...checkPrev.map(c => c.high));
              if (maxHigh < candle1.high) {
                  if (await this.checkVolumeIncrease(symbol)) {
                const sl = candle1.high;
                const tp = candle3.close - 40 * (sl - candle3.close);
                try {
                this.placeFullOrder({
                  userId: '68c6276c227c0a83f0f3823d',
                  symbol,
                  side: 'SELL',
                  type: 'MARKET',
                  stopLoss: sl,
                  takeProfit: tp,
                  isScalping: true,
                  patternType: 'INVERSE_HAMMER',
                  historyCheckCandles: numCandles
                });
                console.log(`INVERSE HAMMER SHORT detected and entered: ${symbol}`);
                return;
                   } catch (error) {
                  
                }
              }
              }
            }
          } catch (e) {
            console.error(`Failed to fetch historical klines for ${symbol}:`, e);
          }
        }
      }
      if (this.isBullishSpinningTop(candle1)) {
        if ((candle1.high - candle1.low) / candle1.low > this.MAX_RANGE_PERCENT) return;
        if ((candle2.high - candle2.low) / candle2.low > this.MAX_RANGE_PERCENT) return;
        if ((candle3.high - candle3.low) / candle3.low > this.MAX_RANGE_PERCENT) return;
        if (candle2.low != candle2.open && candle2.close > candle1.high && candle3.high > candle2.high && candle3.low > candle2.low && candle2.low > candle1.low) {
          try {
          //  console.log(`Bullish Spinning Top detected on ${symbol} at ${new Date(candle1.startTime).toISOString()}`);
            const historical = await this.publicRest.getKlines({
              symbol,
              interval: '1m',
              limit: maxCandles,
              endTime: candle1.startTime - 1
            });
            const prev = historical.map(k => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const checkWindows = [1440, 720, 240, 180, 120, 60];
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const minLow = Math.min(...checkPrev.map(c => c.low));
              if (minLow > candle1.low) {
                  if (await this.checkVolumeIncrease(symbol)) {
                const sl = candle1.low;
                const tp = candle3.close + 40 * (candle3.close - sl);
                try {
                this.placeFullOrder({
                  userId: '68c6276c227c0a83f0f3823d',
                  symbol,
                  side: 'BUY',
                  type: 'MARKET',
                  stopLoss: sl,
                  takeProfit: tp,
                  isScalping: true,
                  patternType: 'BULLISH_SPINNING_TOP',
                  historyCheckCandles: numCandles
                });
                console.log(`BULLISH SPINNING TOP LONG detected and entered: ${symbol}`);
                return;
                   } catch (error) {
                }
              }
            }
            }
          } catch (e) {
            console.error(`Failed to fetch historical klines for ${symbol}:`, e);
          }
        }
      }
      if (this.isBearishSpinningTop(candle1)) {
        if ((candle1.high - candle1.low) / candle1.low > this.MAX_RANGE_PERCENT) return;
        if ((candle2.high - candle2.low) / candle2.low > this.MAX_RANGE_PERCENT) return;
        if ((candle3.high - candle3.low) / candle3.low > this.MAX_RANGE_PERCENT) return;
        if (candle2.high != candle2.open && candle2.close < candle1.low && candle3.low < candle2.low && candle3.high < candle2.high && candle2.high < candle1.high) {
          try {
          //  console.log(`Bearish Spinning Top detected on ${symbol} at ${new Date(candle1.startTime).toISOString()}`);
            const historical = await this.publicRest.getKlines({
              symbol,
              interval: '1m',
              limit: maxCandles,
              endTime: candle1.startTime - 1
            });
            const prev = historical.map(k => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const checkWindows = [1440, 720, 240, 180, 120, 60];
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const maxHigh = Math.max(...checkPrev.map(c => c.high));
              if (maxHigh < candle1.high) {
                  if (await this.checkVolumeIncrease(symbol)) {
                const sl = candle1.high;
                const tp = candle3.close - 40 * (sl - candle3.close);
                try {
                this.placeFullOrder({
                  userId: '68c6276c227c0a83f0f3823d',
                  symbol,
                  side: 'SELL',
                  type: 'MARKET',
                  stopLoss: sl,
                  takeProfit: tp,
                  isScalping: true,
                  patternType: 'BEARISH_SPINNING_TOP',
                  historyCheckCandles: numCandles
                });
                console.log(`BEARISH SPINNING TOP SHORT detected and entered: ${symbol}`);
                return;
                  } catch (error) {
                  
                }
              }
              }
            }
          } catch (e) {
            console.error(`Failed to fetch historical klines for ${symbol}:`, e);
          }
        }
      }
    } else {
      const candle4 = candles[idx];
      const candle3 = candles[idx - 1];
      const candle2 = candles[idx - 2];
      const candle1 = candles[idx - 3];
      if (candle4) {
        if ((candle1.high - candle1.low) / candle1.low > this.MAX_RANGE_PERCENT || (candle2.high - candle2.low) / candle2.low > this.MAX_RANGE_PERCENT) return;
        if ((candle3.high - candle3.low) / candle3.low > this.MAX_RANGE_PERCENT) return;
        if ((candle4.high - candle4.low) / candle4.low > this.MAX_RANGE_PERCENT) return;
        if (
         ( candle1.close < candle1.open && candle2.open <=candle1.close
          && candle2.low < candle1.low && candle2.high > candle1.high && candle2.close>candle1.open
        ) && (
          candle3.low > candle2.low && candle3.close > candle2.high && candle3.close > candle3.open && candle3.open !== candle3.low
        ) &&(candle4.high>candle3.high && candle4.low > candle3.low)
        ) {
         //   console.log(`Bullish Engulfing detected on ${symbol} at ${new Date(candle2.startTime).toISOString()}`);
          try {
            const historical = await this.publicRest.getKlines({
              symbol,
              interval: '1m',
              limit: maxCandles,
              endTime: candle2.startTime - 1
            });
            const prev = historical.map(k => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const checkWindows = [1440, 720, 240, 180, 120, 60];
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const minLow = Math.min(...checkPrev.map(c => c.low));
              const patternLow = Math.min(candle1.low, candle2.low);
              if (minLow > patternLow) {
                  if (await this.checkVolumeIncrease(symbol)) {
                const sl = candle2.low;
                const tp = candle4.close + 40 * (candle4.close - sl);
                try {
                this.placeFullOrder({
                  userId: '68c6276c227c0a83f0f3823d',
                  symbol,
                  side: 'BUY',
                  type: 'MARKET',
                  stopLoss: sl,
                  takeProfit: tp,
                  isScalping: true,
                  patternType: 'BULLISH_ENGULFING',
                  historyCheckCandles: numCandles
                });
                console.log(`BULLISH ENGULFING LONG detected and entered: ${symbol}`);
                return;
                } catch (error) {
                  
                }
              }
            }
            }
          } catch (e) {
            console.error(`Failed to fetch historical klines for ${symbol}:`, e);
          }
        }
      }
      if (candle4) {
        if ((candle1.high - candle1.low) / candle1.low > this.MAX_RANGE_PERCENT || (candle2.high - candle2.low) / candle2.low > this.MAX_RANGE_PERCENT) return;
        if ((candle3.high - candle3.low) / candle3.low > this.MAX_RANGE_PERCENT) return;
        if ((candle4.high - candle4.low) / candle4.low > this.MAX_RANGE_PERCENT) return;
       if (
         ( candle1.close > candle1.open && candle2.open >=candle1.close
          && candle2.low < candle1.low && candle2.high > candle1.high && candle2.close<candle1.open) &&
         (candle3.high < candle2.high && candle3.close < candle2.low && candle3.close < candle3.open && candle3.open !== candle3.high) &&
         (candle4.low < candle3.low && candle4.high < candle3.high)
        ) {
          // console.log(`Bearish Engulfing detected on ${symbol} at ${new Date(candle2.startTime).toISOString()}`);
          try {
            const historical = await this.publicRest.getKlines({
              symbol,
              interval: '1m',
              limit: maxCandles,
              endTime: candle2.startTime - 1
            });
            const prev = historical.map(k => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const checkWindows = [1440, 720, 240, 180, 120, 60];
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const maxHigh = Math.max(...checkPrev.map(c => c.high));
              const patternHigh = Math.max(candle1.high, candle2.high);
              if (maxHigh < patternHigh) {
                  if (await this.checkVolumeIncrease(symbol)) {
                const sl = candle2.high;
                const tp = candle4.close - 40 * (sl - candle4.close);
                try {
                this.placeFullOrder({
                  userId: '68c6276c227c0a83f0f3823d',
                  symbol,
                  side: 'SELL',
                  type: 'MARKET',
                  stopLoss: sl,
                  takeProfit: tp,
                  isScalping: true,
                  patternType: 'BEARISH_ENGULFING',
                  historyCheckCandles: numCandles
                });
                console.log(`BEARISH ENGULFING SHORT detected and entered: ${symbol}`);
                return;
                } catch (error) {
                  
                }
              }
              }
            }
          } catch (e) {
            console.error(`Failed to fetch historical klines for ${symbol}:`, e);
          }
        }
      }
      if (candle4) {
        if ((candle1.high - candle1.low) / candle1.low > this.MAX_RANGE_PERCENT || (candle2.high - candle2.low) / candle2.low > this.MAX_RANGE_PERCENT) return;
        if ((candle3.high - candle3.low) / candle3.low > this.MAX_RANGE_PERCENT) return;
        if ((candle4.high - candle4.low) / candle4.low > this.MAX_RANGE_PERCENT) return;
      if (
        candle1.close < candle1.open && candle2.low >candle1.low && candle2.high <candle1.high && candle2.open >= candle1.close && candle2.close <= candle1.open && candle2.close > candle2.open &&
        candle3.close > candle3.open && candle3.close > candle1.high && candle3.low > candle2.low && candle3.open !== candle3.low &&
         candle4.high > candle3.high && candle4.low > candle3.low
         ) {
         //   console.log(`Bullish Harami detected on ${symbol} at ${new Date(candle2.startTime).toISOString()}`);
          try {
            const historical = await this.publicRest.getKlines({
              symbol,
              interval: '1m',
              limit: maxCandles,
              endTime: candle2.startTime - 1
            });
            const prev = historical.map(k => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const checkWindows = [1440, 720, 240, 180, 120, 60];
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const minLow = Math.min(...checkPrev.map(c => c.low));
              const patternLow = Math.min(candle1.low, candle2.low);
              if (minLow > patternLow) {
                  if (await this.checkVolumeIncrease(symbol)) {
                const sl = candle1.low
                const tp = candle4.close + 40 * (candle4.close - sl);
                try {
                this.placeFullOrder({
                  userId: '68c6276c227c0a83f0f3823d',
                  symbol,
                  side: 'BUY',
                  type: 'MARKET',
                  stopLoss: sl,
                  takeProfit: tp,
                  isScalping: true,
                  patternType: 'BULLISH_HARAMI',
                  historyCheckCandles: numCandles
                });
                console.log(`BULLISH HARAMI LONG detected and entered: ${symbol}`);
                return;
                    } catch (error) {
                  
                }
              }
              }
            }
          } catch (e) {
            console.error(`Failed to fetch historical klines for ${symbol}:`, e);
          }
        }
      }
      if ( candle4) {
        if ((candle1.high - candle1.low) / candle1.low > this.MAX_RANGE_PERCENT || (candle2.high - candle2.low) / candle2.low > this.MAX_RANGE_PERCENT) return;
        if ((candle3.high - candle3.low) / candle3.low > this.MAX_RANGE_PERCENT) return;
        if ((candle4.high - candle4.low) / candle4.low > this.MAX_RANGE_PERCENT) return;
      if (
    candle1.close > candle1.open && candle2.low >candle1.low && candle2.high <candle1.high && candle2.open <= candle1.close && candle2.close >= candle1.open && candle2.close < candle2.open &&
        candle3.close < candle3.open && candle3.close < candle1.low && candle3.high < candle2.high && candle3.open !== candle3.high &&
         candle4.low < candle3.low && candle4.high < candle3.high
  ) {
   // console.log(`Bearish Harami detected on ${symbol} at ${new Date(candle2.startTime).toISOString()}`);
          try {
            const historical = await this.publicRest.getKlines({
              symbol,
              interval: '1m',
              limit: maxCandles,
              endTime: candle2.startTime - 1
            });
            const prev = historical.map(k => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const checkWindows = [1440, 720, 240, 180, 120, 60];
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const maxHigh = Math.max(...checkPrev.map(c => c.high));
              const patternHigh = Math.max(candle1.high, candle2.high);
              if (maxHigh < patternHigh) {
                  if (await this.checkVolumeIncrease(symbol)) {
                const sl = candle1.high;
                const tp = candle4.close - 40 * (sl - candle4.close);
                try {
                this.placeFullOrder({
                  userId: '68c6276c227c0a83f0f3823d',
                  symbol,
                  side: 'SELL',
                  type: 'MARKET',
                  stopLoss: sl,
                  takeProfit: tp,
                  isScalping: true,
                  patternType: 'BEARISH_HARAMI',
                  historyCheckCandles: numCandles
                });
                console.log(`BEARISH HARAMI SHORT detected and entered: ${symbol}`);
                return;
                  } catch (error) {
                }
              }
              }
            }
          } catch (e) {
            console.error(`Failed to fetch historical klines for ${symbol}:`, e);
          }
        }
      }
      for (let numInside = 5; numInside >= 1; numInside--) {
        const motherIndex = idx - (numInside + 2);
        if (motherIndex < 0) continue;
        const mother = candles[motherIndex];
        let allInside = true;
        for (let i = 1; i <= numInside; i++) {
          const insideC = candles[motherIndex + i];
          if (!(insideC.high <= mother.high && insideC.low >= mother.low)) {
            allInside = false;
            break;
          }
        }
        if (!allInside) continue;
        const breakout = candles[idx - 1];
        const confirm = candles[idx];
        let maxRangeExceeded = false;
        for (let i = 0; i <= numInside + 2; i++) {
          const c = candles[motherIndex + i];
          if ((c.high - c.low) / c.low > this.MAX_RANGE_PERCENT) {
            maxRangeExceeded = true;
            break;
          }
        }
        if (maxRangeExceeded) continue;
        if (
          (mother.close < mother.open) &&
          (breakout.close > mother.high && breakout.low > mother.low && breakout.close > breakout.open && breakout.open !== breakout.low) &&
          (confirm.high > breakout.high && confirm.low > breakout.low)
        ) {
        //  console.log(`Bullish Inside Bar (${numInside} insides) detected on ${symbol} at ${new Date(mother.startTime).toISOString()}`);
          try {
            const historical = await this.publicRest.getKlines({
              symbol,
              interval: '1m',
              limit: maxCandles,
              endTime: mother.startTime - 1
            });
            const prev = historical.map(k => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const checkWindows = [1440, 720, 240, 180, 120, 60];
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const minLow = Math.min(...checkPrev.map(c => c.low));
              const patternLow = mother.low;
              if (minLow > patternLow) {
                  if (await this.checkVolumeIncrease(symbol)) {
                const sl = patternLow;
                const tp = confirm.close + 40 * (confirm.close - sl);
                try {
                this.placeFullOrder({
                  userId: '68c6276c227c0a83f0f3823d',
                  symbol,
                  side: 'BUY',
                  type: 'MARKET',
                  stopLoss: sl,
                  takeProfit: tp,
                  isScalping: true,
                  patternType: 'BULLISH_INSIDE_BAR',
                  historyCheckCandles: numCandles
                });
                console.log(`BULLISH INSIDE BAR LONG detected and entered: ${symbol}`);
                return;
                     
                } catch (error) {
                  
                }
              }
              }
            }
          } catch (e) {
            console.error(`Failed to fetch historical klines for ${symbol}:`, e);
          }
        }
        if (
          (mother.close > mother.open) &&
          (breakout.close < mother.low && breakout.high <= mother.high && breakout.close < breakout.open && breakout.open !== breakout.high) &&
          (confirm.low < breakout.low && confirm.high < breakout.high)
        ) {
        //  console.log(`Bearish Inside Bar (${numInside} insides) detected on ${symbol} at ${new Date(mother.startTime).toISOString()}`);
          try {
            const historical = await this.publicRest.getKlines({
              symbol,
              interval: '1m',
              limit: maxCandles,
              endTime: mother.startTime - 1
            });
            const prev = historical.map(k => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const checkWindows = [1440, 720, 240, 180, 120, 60];
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const maxHigh = Math.max(...checkPrev.map(c => c.high));
              const patternHigh = mother.high;
              if (maxHigh < patternHigh) {
                  if (await this.checkVolumeIncrease(symbol)) {
                const sl = patternHigh;
                const tp = confirm.close - 40 * (sl - confirm.close);
                try {
                this.placeFullOrder({
                  userId: '68c6276c227c0a83f0f3823d',
                  symbol,
                  side: 'SELL',
                  type: 'MARKET',
                  stopLoss: sl,
                  takeProfit: tp,
                  isScalping: true,
                  patternType: 'BEARISH_INSIDE_BAR',
                  historyCheckCandles: numCandles
                });
                console.log(`BEARISH INSIDE BAR SHORT detected and entered: ${symbol}`);
                return;
                  } catch (error) {
                  
                }
              }
              }
            }
          } catch (e) {
            console.error(`Failed to fetch historical klines for ${symbol}:`, e);
          }
        }
      }
    }
  }

  private isHammer(c: any): boolean {
    const body = Math.abs(c.close - c.open);
    const lowerShadow = Math.min(c.open, c.close) - c.low;
    const upperShadow = c.high - Math.max(c.open, c.close);
    const range = c.high - c.low || 1e-8;
    return lowerShadow >= 2 * body && upperShadow <= 0.25 * Math.max(body, 1e-8) && lowerShadow / range >= 0.66 && c.close > c.open;
  }

  private isInverseHammer(c: any): boolean {
    const body = Math.abs(c.close - c.open);
    const upperShadow = c.high - Math.max(c.open, c.close);
    const lowerShadow = Math.min(c.open, c.close) - c.low;
    const range = c.high - c.low || 1e-8;
    return upperShadow >= 2 * body && lowerShadow <= 0.25 * Math.max(body, 1e-8) && upperShadow / range >= 0.66 && c.close < c.open;
  }

  isBullishSpinningTop(c: any): boolean {
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low || 1e-8;
    const upperShadow = c.high - Math.max(c.open, c.close);
    const lowerShadow = Math.min(c.open, c.close) - c.low;
    return body / range <= 0.3 && upperShadow >= body && lowerShadow >= body && c.close > c.open;
  }

  private isBearishSpinningTop(c: any): boolean {
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low || 1e-8;
    const upperShadow = c.high - Math.max(c.open, c.close);
    const lowerShadow = Math.min(c.open, c.close) - c.low;
    return body / range <= 0.3 && upperShadow >= body && lowerShadow >= body && c.close < c.open;
  }

  async onModuleDestroy() {}

  private async executeTrail(userId: string, key: string, state: any, currentPrice: number) {
    const oldkey = key;
    const symbol = state.symbol;
    const positionSide = state.positionSide;
    const qty = state.qty;
    const side = state.side;
    let oldSlExists = this.virtualOrders.has(state.slClientId);
    let oldTpExists = this.virtualOrders.has(state.tpClientId);
    if (!oldSlExists && !oldTpExists) {
      this.trailingState.delete(oldkey);
      return;
    }
    const precision = await this.getSymbolPrecision(symbol);
    const rootClientId = uuidv4().replace(/-/g, '').substring(0, 14);
    const newSlId = `${this.OUR_CLIENT_PREFIX}_sl-${rootClientId}`;
    const newTpId = `${this.OUR_CLIENT_PREFIX}_tp-${rootClientId}`;
    const isLong = side === 'BUY';
    const isBigMove = isLong ? currentPrice >= state.bigMoveTriggerPrice : currentPrice <= state.bigMoveTriggerPrice;
    const newSlTrigger = isBigMove ? state.bigMoveNextSL : state.nextSL;
    const newTpTrigger = isBigMove ? state.bigMoveNextTP : state.nextTP;
    const betterSL = isLong ? (newSlTrigger > state.currentSL) : (newSlTrigger < state.currentSL);
    const betterTP = isLong ? (newTpTrigger > state.currentTP) : (newTpTrigger < state.currentTP);
    if (betterSL && betterTP) {
      this.virtualOrders.set(newSlId, {
        symbol, side: side === 'BUY' ? 'SELL' : 'BUY', type: 'STOP_MARKET', triggerPrice: newSlTrigger,
        quantity: Number(qty), positionSide, workingType: 'MARK_PRICE', clientAlgoId: newSlId
      });
      this.virtualOrders.delete(state.slClientId);
      this.virtualOrders.set(newTpId, {
        symbol, side: side === 'BUY' ? 'SELL' : 'BUY', type: 'TAKE_PROFIT_MARKET', triggerPrice: newTpTrigger,
        quantity: Number(qty), positionSide, workingType: 'MARK_PRICE', clientAlgoId: newTpId
      });
      this.virtualOrders.delete(state.tpClientId);
      const newKey = `${userId}-${symbol}-${positionSide}-${side}-${newSlId}-${newTpId}`;
      let newNextTriggerPrice = state.nextTriggerPrice;
      let newNextSL = state.nextSL;
      let newNextTP = state.nextTP;
      let newBigMoveTriggerPrice = state.bigMoveTriggerPrice;
      let newBigMoveNextSL = state.bigMoveNextSL;
      let newBigMoveNextTP = state.bigMoveNextTP;
      if (isBigMove) {
        newNextTriggerPrice = this.round(isLong ? newSlTrigger * 1.10 : newSlTrigger / 1.10, precision.pricePrecision);
        newNextSL = this.round(isLong ? newSlTrigger * 1.03 : newSlTrigger / 1.03, precision.pricePrecision);
        newNextTP = this.round(isLong ? newTpTrigger * 1.03 : newTpTrigger / 1.03, precision.pricePrecision);
        newBigMoveTriggerPrice = this.round(isLong ? newSlTrigger * 1.36 : newSlTrigger / 1.36, precision.pricePrecision);
        newBigMoveNextSL = this.round(isLong ? newSlTrigger * 1.30 : newSlTrigger / 1.30, precision.pricePrecision);
        newBigMoveNextTP = this.round(isLong ? newTpTrigger * 1.30 : newTpTrigger / 1.30, precision.pricePrecision);
      } else {
        newNextTriggerPrice = this.round(isLong ? newSlTrigger * 1.10 : newSlTrigger / 1.10, precision.pricePrecision);
        newNextSL = this.round(isLong ? newSlTrigger * 1.03 : newSlTrigger / 1.03, precision.pricePrecision);
        newNextTP = this.round(isLong ? newTpTrigger * 1.03 : newTpTrigger / 1.03, precision.pricePrecision);
      }
      this.trailingState.set(newKey, {
        ...state,
        currentSL: newSlTrigger,
        currentTP: newTpTrigger,
        trailCount: state.trailCount + 1,
        nextTriggerPrice: newNextTriggerPrice,
        nextSL: newNextSL,
        nextTP: newNextTP,
        bigMoveTriggerPrice: newBigMoveTriggerPrice,
        bigMoveNextSL: newBigMoveNextSL,
        bigMoveNextTP: newBigMoveNextTP,
        slClientId: newSlId,
        tpClientId: newTpId
      });
      this.trailingState.delete(oldkey);
    } else {
      if (isBigMove) {
        state.nextTriggerPrice = this.round(isLong ? state.currentSL * 1.10 : state.currentSL / 1.10, precision.pricePrecision);
        state.nextSL = this.round(isLong ? state.currentSL * 1.03 : state.currentSL / 1.03, precision.pricePrecision);
        state.nextTP = this.round(isLong ? state.currentTP * 1.03 : state.currentTP / 1.03, precision.pricePrecision);
        state.bigMoveTriggerPrice = this.round(isLong ? state.currentSL * 1.36 : state.currentSL / 1.36, precision.pricePrecision);
        state.bigMoveNextSL = this.round(isLong ? state.currentSL * 1.30 : state.currentSL / 1.30, precision.pricePrecision);
        state.bigMoveNextTP = this.round(isLong ? state.currentTP * 1.30 : state.currentTP / 1.30, precision.pricePrecision);
      } else {
        state.nextTriggerPrice = this.round(isLong ? state.currentSL * 1.10 : state.currentSL / 1.10, precision.pricePrecision);
        state.nextSL = this.round(isLong ? state.currentSL * 1.03 : state.currentSL / 1.03, precision.pricePrecision);
        state.nextTP = this.round(isLong ? state.currentTP * 1.03 : state.currentTP / 1.03, precision.pricePrecision);
      }
    }
  }

  private resetDailyCounters(userId: string) {
    const state = this.getUserState(userId);
    const now = new Date();
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const istTime = new Date(now.getTime() + IST_OFFSET_MS);
    const todayIST = new Date(istTime.getUTCFullYear(), istTime.getUTCMonth(), istTime.getUTCDate());
    if (!state.lastResetDate || state.lastResetDate < todayIST) {
      state.dailyEntryCount = 0;
      state.symbolEntryCounts.clear();
      state.lastResetDate = todayIST;
    }
  }

  private canPlaceEntry(userId: string): { allowed: boolean; reason?: string } {
    this.resetDailyCounters(userId);
    const state = this.getUserState(userId);
    const now = new Date();
    const hoursUTC = now.getUTCHours();
    const minutesUTC = now.getUTCMinutes();
    const currentMinutes = hoursUTC * 60 + minutesUTC;
    const banStart = 3 * 60 + 30;
  //  const banEnd = 17 * 60 + 30;
  const banEnd = 3 * 60 + 30;
    if (currentMinutes >= banStart && currentMinutes < banEnd) {
      return { allowed: false, reason: 'Entries banned during 03:30-17:30 UTC (9 AM-11 PM IST)' };
    }
    if (state.dailyEntryCount >= 30) return { allowed: false, reason: 'Max 30 entries/day reached' };
    return { allowed: true };
  }

  private canEnterSymbolSide(userId: string, symbol: string, positionSide: 'LONG' | 'SHORT'): { allowed: boolean; reason?: string } {
    const state = this.getUserState(userId);
    const key = `${symbol}-${positionSide}`;
    const count = state.symbolEntryCounts.get(key) || 0;
    if (count >= 3) return { allowed: false, reason: `Max 3 entries/day for ${symbol} ${positionSide}` };
    return { allowed: true };
  }

  async placeFullOrder(params: {
    userId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'MARKET';
    stopLoss: number;
    takeProfit: number;
    isScalping?: boolean;
    patternType: 'HAMMER' | 'INVERSE_HAMMER' | 'BULLISH_ENGULFING' | 'BEARISH_ENGULFING' | 'BULLISH_HARAMI' | 'BEARISH_HARAMI' | 'BULLISH_SPINNING_TOP' | 'BEARISH_SPINNING_TOP' | 'BULLISH_INSIDE_BAR' | 'BEARISH_INSIDE_BAR';
    historyCheckCandles?: number;
  }) {
    const { userId, symbol, side, stopLoss, takeProfit, isScalping = false, patternType, historyCheckCandles } = params;
    const state = this.getUserState(userId);
    const canEnter = this.canPlaceEntry(userId);
    if (!canEnter.allowed) throw new Error(`ENTRY BLOCKED: ${canEnter.reason}`);
    const targetPositionSide = side === 'BUY' ? 'LONG' : 'SHORT';
    const symbolLimit = this.canEnterSymbolSide(userId, symbol, targetPositionSide);
    if (!symbolLimit.allowed) throw new Error(`ENTRY BLOCKED: ${symbolLimit.reason}`);


  const existingPosKey = `${symbol}-${targetPositionSide}`;
    if (this.virtualPositions.has(existingPosKey)) {
      throw new Error(`ENTRY BLOCKED: Position already running for ${symbol} ${targetPositionSide}`);
    }

    const precision = await this.getSymbolPrecision(symbol);
    const candles = this.candles1m[symbol] || [];
    if (candles.length === 0) throw new Error('No candle data for mark price');
    const latestCandle = candles[candles.length - 1];
    const markPrice = latestCandle.close;
    if (markPrice <= 0) throw new Error('No mark price');
    const priceDiff = Math.abs(markPrice - stopLoss);
    const riskAmount = 0.000002 * (await this.getUsdtBalance(userId));
    const rawQty = riskAmount / priceDiff;
    const quantity = rawQty < 1 ? rawQty.toFixed(precision.qtyPrecision) : Math.round(rawQty).toString();
    const notional = parseFloat(quantity) * markPrice;
    if (notional < 5) throw new Error('Notional <5');
    const leverage = 20;
    const allocated = notional / leverage;
    const user = await this.userModel.findById(userId);
    if (!user) throw new Error('User not found');
    if (user.balance < allocated) throw new Error('Insufficient balance');
    user.balance -= allocated;
    await user.save();
    const posKey = `${symbol}-${targetPositionSide}`;
    this.virtualPositions.set(posKey, {
      symbol,
      side,
      qty: parseFloat(quantity),
      entryPrice: markPrice,
      allocatedMargin: allocated,
      leverage,
      positionSide: targetPositionSide,
      entryTime: new Date(),
      riskAmount,
      patternType,
      historyCheckCandles
    });
    state.dailyEntryCount++;
    const symbolSideKey = `${symbol}-${targetPositionSide}`;
    state.symbolEntryCounts.set(symbolSideKey, (state.symbolEntryCounts.get(symbolSideKey) || 0) + 1);
    const rootClientId = uuidv4().replace(/-/g, '').substring(0, 14);
    const slClientId = `${this.OUR_CLIENT_PREFIX}_sl-${rootClientId}`;
    const tpClientId = `${this.OUR_CLIENT_PREFIX}_tp-${rootClientId}`;
    this.virtualOrders.set(slClientId, { symbol, side: side === 'BUY' ? 'SELL' : 'BUY', type: 'STOP_MARKET', triggerPrice: stopLoss, quantity: parseFloat(quantity), positionSide: targetPositionSide, workingType: 'MARK_PRICE', clientAlgoId: slClientId });
    this.virtualOrders.set(tpClientId, { symbol, side: side === 'BUY' ? 'SELL' : 'BUY', type: 'TAKE_PROFIT_MARKET', triggerPrice: takeProfit, quantity: parseFloat(quantity), positionSide: targetPositionSide, workingType: 'MARK_PRICE', clientAlgoId: tpClientId });
    const key = `${userId}-${symbol}-${targetPositionSide}-${side}-${slClientId}-${tpClientId}`;
    this.trailingState.set(key, {
      side, symbol, positionSide: targetPositionSide as any, currentSL: stopLoss, currentTP: takeProfit, qty: quantity, trailCount: 0, isScalping,
      nextTriggerPrice: this.round(side === 'BUY' ? stopLoss * 1.03 : stopLoss / 1.03, precision.pricePrecision),
      nextSL: this.round(side === 'BUY' ? stopLoss * 1.003 : stopLoss / 1.003, precision.pricePrecision),
      nextTP: this.round(side === 'BUY' ? takeProfit * 1.003 : takeProfit / 1.003, precision.pricePrecision),
      bigMoveTriggerPrice: this.round(side === 'BUY' ? stopLoss * 1.36 : stopLoss / 1.36, precision.pricePrecision),
      bigMoveNextSL: this.round(side === 'BUY' ? stopLoss * 1.30 : stopLoss / 1.30, precision.pricePrecision),
      bigMoveNextTP: this.round(side === 'BUY' ? takeProfit * 1.30 : takeProfit / 1.30, precision.pricePrecision),
      slClientId, tpClientId
    });
  //  console.log(`[${userId}] ENTRY ${side} ${symbol} ${targetPositionSide} | SL:${stopLoss} TP:${takeProfit}`);
   // console.log(`LIVE POSITION: ${side} ${symbol} ${targetPositionSide} | Qty: ${quantity} | Entry: ${markPrice} | SL: ${stopLoss} | TP: ${takeProfit} | Margin: ${allocated.toFixed(2)} USDT`);
  }

  private getUserState(userId: string): UserBotState {
    return this.userStates.get(userId)!;
  }

  public async getBotStatus(userId: string) {
    this.resetDailyCounters(userId);
    const state = this.getUserState(userId);
    const status = {
      dailyEntries: state.dailyEntryCount,
      maxDailyEntries: 30,
      virtualBalance: await this.getUsdtBalance(userId)
    };
    this.emitLiveDataNow(userId);
    return status;
  }

  async getUsdmSymbols(userId: string): Promise<string[]> {
    const info = await this.publicRest.getExchangeInfo();
    return info.symbols
      .filter((s: any) => s.contractType === 'PERPETUAL' && s.status === 'TRADING' && s.quoteAsset === 'USDT')
      .map((s: any) => s.symbol)
      .sort();
  }

  async getUsdtBalance(userId: string): Promise<number> {
    const user = await this.userModel.findById(userId);
    if (!user) throw new Error('User not found');
    return user.balance;
  }

  async getTradeStats(userId: string) {
    const trades = await this.tradeModel.find({ userId });
    const totalTrades = trades.length;
    const wins = trades.filter(t => t.isWin).length;
    const losses = totalTrades - wins;
    const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
    return { totalTrades, wins, losses, totalPnl };
  }

  async getTradeHistory(userId: string, page: number = 1, limit: number = 10, symbol?: string) {
    const skip = (page - 1) * limit;
    const query: any = { userId };
    if (symbol) query.symbol = symbol;
    const [trades, total] = await Promise.all([
      this.tradeModel
        .find(query)
        .sort({ exitTime: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.tradeModel.countDocuments(query).exec(),
    ]);
    return {
      trades,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getTodayEntries(userId: string) {
    const state = this.getUserState(userId);
    this.resetDailyCounters(userId);
    return state.dailyEntryCount;
  }

  async getSymbolTodayEntries(userId: string, symbol: string) {
    const state = this.getUserState(userId);
    const longKey = `${symbol}-LONG`;
    const shortKey = `${symbol}-SHORT`;
    return (state.symbolEntryCounts.get(longKey) || 0) + (state.symbolEntryCounts.get(shortKey) || 0);
  }

  private emitLiveDataNow(userId: string = '68c6276c227c0a83f0f3823d') {
    const positions = Array.from(this.virtualPositions.values()).map(pos => ({
      ...pos,
      currentPrice: this.candles1m[pos.symbol]?.[this.candles1m[pos.symbol].length - 1]?.close || pos.entryPrice,
      entryTime: pos.entryTime.toISOString()
    }));
    const filteredPendingOrders = Array.from(this.virtualOrders.values()).map(order => ({
      ClientId: order.clientAlgoId,
      type: order.type,
      symbol: order.symbol,
      side: order.side,
      positionSide: order.positionSide,
      Qty: order.quantity,
      stopLoss: order.triggerPrice
    }));
    const accountId = 'default';
    const room = `${userId}_${accountId}`;
    this.socketServer?.to(room).emit('live-data', { positionData: { positions, filteredPendingOrders } });
  }
}


*/








