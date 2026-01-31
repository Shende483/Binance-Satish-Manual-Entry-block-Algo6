

// src/modules/tradingBotModule/trading-bot.service.ts
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { WebsocketClient, USDMClient, MarginType } from 'binance';
import { Console } from 'console';
import * as moment from 'moment';
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';

interface UserTradingConfig {
  API_KEY: string;
  API_SECRET: string;
  RISK_PERCENT: number;
  LEVERAGE: number;
  MARGIN_TYPE: string;
  HEDGE_MODE: boolean;
}

interface UserBotState {
  restingMode: { enabled: boolean; until: number; duration: number };
  burstModeEnabled: boolean;
  burstEntriesLeft: number;
  burstUsesToday: number;
  lastBurstActivationTime: number | null;
  dailyEntryCount: number;
  lastEntryTime: number | null;
  lastResetDate: Date | null;
  slTracker: Map<string, any>;
  config: UserTradingConfig;
  ourClientPrefixes: Set<string>;
  symbolEntryCounts: Map<string, number>;
}

@Injectable()
export class ManualTradingBotService implements OnModuleInit, OnModuleDestroy {
  private socketServer?: Server;
  private userRestClients = new Map<string, USDMClient>();
  private userWsClients = new Map<string, WebsocketClient>();
  private userStates = new Map<string, UserBotState>();
  private processingClose = new Map<string, boolean>();
  private processedMarginAdds = new Set<string>();
  private trailingState = new Map<string, {
    symbol: string;
    side:'BUY'|'SELL';
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
    slClientId:string,
    tpClientId:string
    isScalping: boolean;
  }>();

  private candles1m: Record<string, any[]> = {};
  private candles5m: Record<string, any[]> = {};
  private candles15m: Record<string, any[]> = {};
  private current5mAggregators: Record<string, any> = {};
  private current15mAggregators: Record<string, any> = {};
  private readonly MAX_SYMBOLS_KLINES = 400;

  private serverTimeOffset = 0;
  private readonly OUR_CLIENT_PREFIX = 'x-15PC4ZJy_Xcdr';

  private async getSymbolPrecision(symbol: string) {
    const rest = this.getRestClient('68d3f007099f9de77119b413');
    const info = await rest.getExchangeInfo();
    const s = info.symbols.find((x: any) => x.symbol === symbol);
    if (!s) throw new Error(`Symbol ${symbol} not found`);
    const pricePrecision = s.pricePrecision;
    const qtyPrecision = s.quantityPrecision;
    return { pricePrecision, qtyPrecision };
  }

  private round(value: number, precision: number): number {
    if (precision === 0) return Math.round(value);
    const factor = Math.pow(10, precision);
    return Math.round(value * factor) / factor;
  }

  private async syncServerTime() {
    try {
      const resp = await fetch('https://fapi.binance.com/fapi/v1/time');
      const data = await resp.json();
      this.serverTimeOffset = (data.serverTime as number) - Date.now();
    } catch {
      this.serverTimeOffset = 0;
    }
  }



  async onModuleInit() {
    await this.syncServerTime();
    setInterval(() => this.syncServerTime(), 4 * 60 * 60 * 1000);
    const users = [
      '68d3f007099f9de77119b413',
     // 'sub1-68d3f007099f9de77119b413',
    ];
    for (const userId of users) {
      await this.initUser(userId);
      setTimeout(() => this.restoreBotStateOnStartup(userId), 8000);
    }
  }

  async onModuleDestroy() {
    for (const [userId, wsClient] of this.userWsClients) {
      try {
        await wsClient.closeUserDataStream('usdm' as any, 'usdm' as any);
      } catch (err) {
        console.error(`Failed to close WS for ${userId}:`, err);
      }
    }
    this.userWsClients.clear();
    this.userRestClients.clear();
  }

  async initUser(userId: string) {
    if (this.userRestClients.has(userId)) return;
    const config = this.getUserConfig(userId);
    const restClient = new USDMClient({ api_key: config.API_KEY, api_secret: config.API_SECRET });
    this.userRestClients.set(userId, restClient);

    const wsClient = new WebsocketClient({
      api_key: config.API_KEY,
      api_secret: config.API_SECRET,
      beautify: true,
    });

    wsClient.on('open', () => console.log(`[${userId}] WS opened`));
    wsClient.on('reconnecting', () => console.log(`[${userId}] Reconnecting...`));
    wsClient.on('reconnected', () => console.log(`[${userId}] Reconnected`));

    wsClient.on('message', (raw: any) => {
      const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (msg && msg.e === 'ALGO_UPDATE') {
        const update = msg.o;
      }
      this.onUserDataEvent(userId, msg);
    });

    wsClient.on('formattedUserDataMessage', (data: any) => {
      this.onUserDataEvent(userId, data);
    });

    wsClient.on('formattedMessage', (data: any) => {
      const updates = Array.isArray(data) ? data : [data];
      for (const update of updates) {
        if (update.eventType === 'kline') {
        //  console.log('KLINE DATA:', JSON.stringify(update, null, 2)); // ← add this line
          this.handleKlineUpdate(update);
        }
      }
    });

    if (userId === '68d3f007099f9de77119b413') {
      wsClient.subscribeUsdFuturesUserDataStream();
      const symbols = await this.getUsdmSymbols(userId);
      const limited = symbols.slice(0, this.MAX_SYMBOLS_KLINES);
      for (const sym of limited) {
        wsClient.subscribeKlines(sym.toLowerCase(), '1m', 'usdm');
      }
      console.log(`[${userId}] Subscribed 1m klines for ${limited.length} symbols`);
    }
    this.userWsClients.set(userId, wsClient);
    const state = this.getUserState(userId);
    state.ourClientPrefixes = new Set([this.OUR_CLIENT_PREFIX]);
  }

  private handleKlineUpdate(update: any) {
 const symbol = update.symbol;
// console.log(`[${symbol}] KLINE UPDATE`);
    const k = update.kline;
    const candle = {
      startTime: k.startTime,
      endTime: k.endTime,
      open: Number(k.open),
      high: Number(k.high),
      low: Number(k.low),
      close: Number(k.close),
      volume: Number(k.volume),
      isFinal: k.final,
      quoteVolume: Number(k.quoteVolume),
      trades: k.trades,
      volumeActive: Number(k.activeVolume),
      quoteVolumeActive: Number(k.activeQuoteVolume),
    };

    // Save 1m candle
    if (!this.candles1m[symbol]) this.candles1m[symbol] = [];
    const arr = this.candles1m[symbol];
    if (arr.length === 0 || candle.startTime > arr[arr.length-1].startTime) {
      arr.push(candle);
    } else if (candle.startTime === arr[arr.length-1].startTime) {
      arr[arr.length-1] = candle;
    }
    if (arr.length > 150) arr.shift();
    if (candle.isFinal) {
      // Check pattern on 1m immediately
      this.checkForPatterns(symbol, '1m');
      this.aggregateCandle(symbol, candle, 5, this.current5mAggregators, this.candles5m);
      this.aggregateCandle(symbol, candle, 15, this.current15mAggregators, this.candles15m);

      // Trailing logic (unchanged)
      const price = candle.close;
      for (const [key, state] of this.trailingState.entries()) {
        if (state.symbol !== symbol) continue;
        const isLong = state.side === 'BUY';
        const MAIN_USER_ID = '68d3f007099f9de77119b413';
        const bigTriggered = isLong ? price >= state.bigMoveTriggerPrice : price <= state.bigMoveTriggerPrice;
        if (bigTriggered) {
          if (this.userRestClients.has(MAIN_USER_ID)) {
            this.executeTrail(MAIN_USER_ID, key, state, price).catch(() => {});
          }
        }
        const shouldTrigger = isLong ? price >= state.nextTriggerPrice : price <= state.nextTriggerPrice;
        if (shouldTrigger) {
          if (this.userRestClients.has(MAIN_USER_ID)) {
            this.executeTrail(MAIN_USER_ID, key, state, price).catch(() => {});
          }
        }
      }
    }
  }



    private aggregateCandle(symbol: string, oneMinCandle: any, intervalMin: number, currentAgg: Record<string, any>, candlesArray: Record<string, any[]>) {
    if (!currentAgg[symbol]) {
      const intervalMs = intervalMin * 60 * 1000;
      const startTime = Math.floor(oneMinCandle.startTime / intervalMs) * intervalMs;
      currentAgg[symbol] = {
         startTime,
        open: oneMinCandle.open,
        high: oneMinCandle.high,
        low: oneMinCandle.low,
        close: oneMinCandle.close,
        volume: oneMinCandle.volume,
        quoteVolume: oneMinCandle.quoteVolume,
        trades: oneMinCandle.trades,
        volumeActive: oneMinCandle.volumeActive,
        quoteVolumeActive: oneMinCandle.quoteVolumeActive,
      };
    } else {
      const agg = currentAgg[symbol];
      agg.high = Math.max(agg.high, oneMinCandle.high);
      agg.low = Math.min(agg.low, oneMinCandle.low);
      agg.close = oneMinCandle.close;
      agg.volume += oneMinCandle.volume;
      agg.quoteVolume += oneMinCandle.quoteVolume;
      agg.trades += oneMinCandle.trades;
      agg.volumeActive += oneMinCandle.volumeActive;
      agg.quoteVolumeActive += oneMinCandle.quoteVolumeActive;
    }

    const expectedEnd = currentAgg[symbol].startTime + intervalMin * 60 * 1000 - 1;
    if (oneMinCandle.endTime >= expectedEnd) {
      const completed = { ...currentAgg[symbol], endTime: expectedEnd, isFinal: true };
      if (!candlesArray[symbol]) candlesArray[symbol] = [];
      candlesArray[symbol].push(completed);
      if (candlesArray[symbol].length > 100) candlesArray[symbol].shift();
      delete currentAgg[symbol];
      this.checkForPatterns(symbol, `${intervalMin}m`);
    }
  }

  private async checkForPatterns(symbol: string, interval: string) {

const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const isTradingHours = (utcH >= 17) || (utcH < 3) || (utcH === 3 && utcM < 30);
  if (!isTradingHours) return;

    const candles = this[`candles${interval}` as keyof this][symbol] as any[] || [];
    if (candles.length < 3) return;

    const idx = candles.length - 1;
    const intervalMin = parseInt(interval.replace('m', ''));
    const maxPercent = this.getMaxRangePercent(interval);
    const maxCandles = Math.ceil(1440 / intervalMin) + 10;

    if (candles.length === 3) {
      const candle3 = candles[idx];
      const candle2 = candles[idx - 1];
      const candle1 = candles[idx - 2];
//console.log(`Checking patterns for candle, Symbol: ${symbol}, Interval: ${interval}`,candle1,candle2,candle3);
      if (this.isHammer(candle1)) {
        if ((candle1.high - candle1.low) / candle1.low > maxPercent) return;
        if ((candle2.high - candle2.low) / candle2.low > maxPercent) return;
        if ((candle3.high - candle3.low) / candle3.low > maxPercent) return;
        if (candle2.low !== candle2.open && candle2.close > candle1.high && candle3.high > candle2.high && candle3.low > candle2.low && candle2.low > candle1.low) {
          try {
            console.log(`Hammer detected on ${symbol}`);
            const historical = await this.getRestClient('68d3f007099f9de77119b413').getKlines({
              symbol,
              interval: interval as any,
              limit: maxCandles,
              endTime: candle1.startTime - 1
            });
            const prev = historical.map((k: any) => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              startTime: Number(k[0]),
              isFinal: true
            }));
            const baseWindows = [60];
            const checkWindows = baseWindows.map(w => Math.ceil(w / intervalMin));
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const minLow = Math.min(...checkPrev.map((c: any) => c.low));
              if (minLow > candle1.low) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (volumeTf && await this.hasHigherTFConfirmation(symbol, 'BUY')) {
                  const sl = candle1.low;
                  const tp = candle3.close + 400 * (candle3.close - sl);
                 
                  await this.placeFullOrder({
                    userId: '68d3f007099f9de77119b413',
                    symbol,
                    side: 'BUY',
                    type: 'MARKET',
                    stopLoss: sl,
                    takeProfit: tp,
                    isScalping: false,
                      isAlgoEntry: true
                  });
                  console.log(`HAMMER LONG entered: ${symbol}`);
                  return;
                }
              }
            }
          } catch (e) {
            console.error(e);
          }
        }
      }

      if (this.isInverseHammer(candle1)) {
         if ((candle1.high - candle1.low) / candle1.low > maxPercent) return;
        if ((candle2.high - candle2.low) / candle2.low > maxPercent) return;
        if ((candle3.high - candle3.low) / candle3.low > maxPercent) return;
        if (candle2.high !== candle2.open && candle2.close < candle1.low && candle3.low < candle2.low && candle3.high < candle2.high && candle2.high < candle1.high) {
          try {
            console.log(`Inverse Hammer detected on ${symbol}`);
            const historical = await this.getRestClient('68d3f007099f9de77119b413').getKlines({
              symbol,
              interval: interval as any,
              limit: maxCandles,
              endTime: candle1.startTime - 1
            });
            const prev = historical.map((k: any) => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              startTime: Number(k[0]),
              isFinal: true
            }));
            const baseWindows = [60];
            const checkWindows = baseWindows.map(w => Math.ceil(w / intervalMin));
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const maxHigh = Math.max(...checkPrev.map((c: any) => c.high));
              if (maxHigh < candle1.high) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (volumeTf && await this.hasHigherTFConfirmation(symbol, 'SELL')) {
                  const sl = candle1.high;
                  const tp = candle3.close - 400 * (sl - candle3.close);
                 
                  await this.placeFullOrder({
                    userId: '68d3f007099f9de77119b413',
                    symbol,
                    side: 'SELL',
                    type: 'MARKET',
                    stopLoss: sl,
                    takeProfit: tp,
                    isScalping: false,
                      isAlgoEntry: true
                  });
                  console.log(`INVERSE HAMMER SHORT entered: ${symbol}`);
                  return;
                }
              }
            }
          } catch (e) {
            console.error(e);
          }
        }
      }

      if (this.isBullishSpinningTop(candle1)) {
        if ((candle1.high - candle1.low) / candle1.low > maxPercent) return;
        if ((candle2.high - candle2.low) / candle2.low > maxPercent) return;
        if ((candle3.high - candle3.low) / candle3.low > maxPercent) return;
        if (candle2.low !== candle2.open && candle2.close > candle1.high && candle3.high > candle2.high && candle3.low > candle2.low && candle2.low > candle1.low) {
          try {
             console.log(`bullish spinning top on ${symbol}`);
            const historical = await this.getRestClient('68d3f007099f9de77119b413').getKlines({
              symbol,
              interval: interval as any,
              limit: maxCandles,
              endTime: candle1.startTime - 1
            });
            const prev = historical.map((k: any) => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              startTime: Number(k[0]),
              isFinal: true
            }));
            const baseWindows = [60];
            const checkWindows = baseWindows.map(w => Math.ceil(w / intervalMin));
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const minLow = Math.min(...checkPrev.map((c: any) => c.low));
              if (minLow > candle1.low) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (volumeTf && await this.hasHigherTFConfirmation(symbol, 'BUY')) {
                  const sl = candle1.low;
                  const tp = candle3.close + 400 * (candle3.close - sl);
                  
                  await this.placeFullOrder({
                    userId: '68d3f007099f9de77119b413',
                    symbol,
                    side: 'BUY',
                    type: 'MARKET',
                    stopLoss: sl,
                    takeProfit: tp,
                   isScalping: false,
                      isAlgoEntry: true
                  });
                  console.log(`BULLISH SPINNING TOP entered: ${symbol}`);
                  return;
                }
              }
            }
          } catch (e) {
            console.error(e);
          }
        }
      }

      if (this.isBearishSpinningTop(candle1)) {
       if ((candle1.high - candle1.low) / candle1.low > maxPercent) return;
        if ((candle2.high - candle2.low) / candle2.low > maxPercent) return;
        if ((candle3.high - candle3.low) / candle3.low > maxPercent) return;
        if (candle2.high !== candle2.open && candle2.close < candle1.low && candle3.low < candle2.low && candle3.high < candle2.high && candle2.high < candle1.high) {
          try {
            console.log(`bearish spinning top on ${symbol}`);
            const historical = await this.getRestClient('68d3f007099f9de77119b413').getKlines({
              symbol,
              interval: interval as any,
              limit: maxCandles,
              endTime: candle1.startTime - 1
            });
            const prev = historical.map((k: any) => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              startTime: Number(k[0]),
              isFinal: true
            }));
            const baseWindows = [60];
            const checkWindows = baseWindows.map(w => Math.ceil(w / intervalMin));
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const maxHigh = Math.max(...checkPrev.map((c: any) => c.high));
              if (maxHigh < candle1.high) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (volumeTf && await this.hasHigherTFConfirmation(symbol, 'SELL')) {
                  const sl = candle1.high;
                  const tp = candle3.close - 400 * (sl - candle3.close);
                  
                  await this.placeFullOrder({
                    userId: '68d3f007099f9de77119b413',
                    symbol,
                    side: 'SELL',
                    type: 'MARKET',
                    stopLoss: sl,
                    takeProfit: tp,
                  isScalping: false,
                      isAlgoEntry: true
                  });
                  console.log(`BEARISH SPINNING TOP entered: ${symbol}`);
                  return;
                }
              }
            }
          } catch (e) {
            console.error(e);
          }
        }
      }
    } else {
      const candle4 = candles[idx];
      const candle3 = candles[idx - 1];
      const candle2 = candles[idx - 2];
      const candle1 = candles[idx - 3];

      if (candle4) {
        if ((candle1.high - candle1.low) / candle1.low > maxPercent || (candle2.high - candle2.low) / candle2.low > maxPercent) return;
        if ((candle3.high - candle3.low) / candle3.low > maxPercent) return;
        if ((candle4.high - candle4.low) / candle4.low > maxPercent) return;
        if (
          candle1.close < candle1.open && candle2.open <= candle1.close &&
          candle2.low < candle1.low && candle2.high > candle1.high && candle2.close > candle1.open &&
          candle3.low > candle2.low && candle3.close > candle2.high && candle3.close > candle3.open && candle3.open !== candle3.low &&
          candle4.high > candle3.high && candle4.low > candle3.low
        ) {
          try {
            console.log(`bullish engulfinfg top on ${symbol}`);
            const historical = await this.getRestClient('68d3f007099f9de77119b413').getKlines({
              symbol,
              interval: interval as any,
              limit: maxCandles,
              endTime: candle2.startTime - 1
            });
            const prev = historical.map((k: any) => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              startTime: Number(k[0]),
              isFinal: true
            }));
            const baseWindows = [60];
            const checkWindows = baseWindows.map(w => Math.ceil(w / intervalMin));
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const minLow = Math.min(...checkPrev.map((c: any) => c.low));
              const patternLow = Math.min(candle1.low, candle2.low);
              if (minLow > patternLow) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (volumeTf && await this.hasHigherTFConfirmation(symbol, 'BUY')) {
                  const sl = candle2.low;
                  const tp = candle4.close + 400 * (candle4.close - sl);
                 
                  await this.placeFullOrder({
                    userId: '68d3f007099f9de77119b413',
                    symbol,
                    side: 'BUY',
                    type: 'MARKET',
                    stopLoss: sl,
                    takeProfit: tp,
                    isScalping: false,
                      isAlgoEntry: true
                  });
                  console.log(`BULLISH ENGULFING LONG entered: ${symbol}`);
                  return;
                }
              }
            }
          } catch (e) {
            console.error(e);
          }
        }
      }

      if (candle4) {
      if ((candle1.high - candle1.low) / candle1.low > maxPercent || (candle2.high - candle2.low) / candle2.low > maxPercent) return;
        if ((candle3.high - candle3.low) / candle3.low > maxPercent) return;
        if ((candle4.high - candle4.low) / candle4.low > maxPercent) return;
        if (
          candle1.close < candle1.open && candle2.low > candle1.low && candle2.high < candle1.high &&
          candle2.open >= candle1.close && candle2.close <= candle1.open && candle2.close > candle2.open &&
          candle3.close > candle3.open && candle3.close > candle1.high && candle3.low > candle2.low &&
          candle4.high > candle3.high && candle4.low > candle3.low &&
          candle3.open !== candle3.high
        ) {
          try {
            console.log(`bearish engulfing top on ${symbol}`);
            const historical = await this.getRestClient('68d3f007099f9de77119b413').getKlines({
              symbol,
              interval: interval as any,
              limit: maxCandles,
              endTime: candle2.startTime - 1
            });
            const prev = historical.map((k: any) => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              startTime: Number(k[0]),
              isFinal: true
            }));
            const baseWindows = [60];
            const checkWindows = baseWindows.map(w => Math.ceil(w / intervalMin));
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const maxHigh = Math.max(...checkPrev.map((c: any) => c.high));
              const patternHigh = Math.max(candle1.high, candle2.high);
              if (maxHigh < patternHigh) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (volumeTf && await this.hasHigherTFConfirmation(symbol, 'SELL')) {
                  const sl = candle2.high;
                  const tp = candle4.close - 400 * (sl - candle4.close);
                 
                  await this.placeFullOrder({
                    userId: '68d3f007099f9de77119b413',
                    symbol,
                    side: 'SELL',
                    type: 'MARKET',
                    stopLoss: sl,
                    takeProfit: tp,
                    isScalping: false,
                      isAlgoEntry: true
                  });
                  console.log(`BEARISH ENGULFING SHORT entered: ${symbol}`);
                  return;
                }
              }
            }
          } catch (e) {
            console.error(e);
          }
        }
      }

      if (candle4) {
        if ((candle1.high - candle1.low) / candle1.low > maxPercent || (candle2.high - candle2.low) / candle2.low > maxPercent) return;
        if ((candle3.high - candle3.low) / candle3.low > maxPercent) return;
        if ((candle4.high - candle4.low) / candle4.low > maxPercent) return;
        if (
          candle1.close < candle1.open && candle2.low > candle1.low && candle2.high < candle1.high &&
          candle2.open >= candle1.close && candle2.close <= candle1.open && candle2.close > candle2.open &&
          candle3.close > candle3.open && candle3.close > candle1.high && candle3.low > candle2.low &&
          candle4.high > candle3.high && candle4.low > candle3.low &&
          candle3.open !== candle3.low
        ) {
          try {
            console.log(`bullish harami top on ${symbol}`);
            const historical = await this.getRestClient('68d3f007099f9de77119b413').getKlines({
              symbol,
              interval: interval as any,
              limit: maxCandles,
              endTime: candle2.startTime - 1
            });
            const prev = historical.map((k: any) => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              startTime: Number(k[0]),
              isFinal: true
            }));
            const baseWindows = [60];
            const checkWindows = baseWindows.map(w => Math.ceil(w / intervalMin));
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const minLow = Math.min(...checkPrev.map((c: any) => c.low));
              const patternLow = Math.min(candle1.low, candle2.low);
              if (minLow > patternLow) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (volumeTf && await this.hasHigherTFConfirmation(symbol, 'BUY')) {
                  const sl = candle1.low;
                  const tp = candle4.close + 400 * (candle4.close - sl);
                  
                  await this.placeFullOrder({
                    userId: '68d3f007099f9de77119b413',
                    symbol,
                    side: 'BUY',
                    type: 'MARKET',
                    stopLoss: sl,
                    takeProfit: tp,
                    isScalping: false,
                      isAlgoEntry: true
                  });
                  console.log(`BULLISH HARAMI LONG entered: ${symbol}`);
                  return;
                }
              }
            }
          } catch (e) {
            console.error(e);
          }
        }
      }

      if (candle4) {
            if ((candle1.high - candle1.low) / candle1.low > maxPercent || (candle2.high - candle2.low) / candle2.low > maxPercent) return;
        if ((candle3.high - candle3.low) / candle3.low > maxPercent) return;
        if ((candle4.high - candle4.low) / candle4.low > maxPercent) return;
        if (
          candle1.close > candle1.open && candle2.low > candle1.low && candle2.high < candle1.high &&
          candle2.open <= candle1.close && candle2.close >= candle1.open && candle2.close < candle2.open &&
          candle3.close < candle3.open && candle3.close < candle1.low && candle3.high < candle2.high &&
          candle4.low < candle3.low && candle4.high < candle3.high &&
          candle3.open !== candle3.high
        ) {
          try {
            console.log(`bearish harami top on ${symbol}`);
            const historical = await this.getRestClient('68d3f007099f9de77119b413').getKlines({
              symbol,
              interval: interval as any,
              limit: maxCandles,
              endTime: candle2.startTime - 1
            });
            const prev = historical.map((k: any) => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              startTime: Number(k[0]),
              isFinal: true
            }));
            const baseWindows = [60];
            const checkWindows = baseWindows.map(w => Math.ceil(w / intervalMin));
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const maxHigh = Math.max(...checkPrev.map((c: any) => c.high));
              const patternHigh = Math.max(candle1.high, candle2.high);
              if (maxHigh < patternHigh) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (volumeTf && await this.hasHigherTFConfirmation(symbol, 'SELL')) {
                  const sl = candle1.high;
                  const tp = candle4.close - 400 * (sl - candle4.close);
                 
                  await this.placeFullOrder({
                    userId: '68d3f007099f9de77119b413',
                    symbol,
                    side: 'SELL',
                    type: 'MARKET',
                    stopLoss: sl,
                    takeProfit: tp,
                   isScalping: false,
                      isAlgoEntry: true
                  });
                  console.log(`BEARISH HARAMI SHORT entered: ${symbol}`);
                  return;
                }
              }
            }
          } catch (e) {
            console.error(e);
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
          if ((c.high - c.low) / c.low > maxPercent) {
            maxRangeExceeded = true;
            break;
          }
        }
        if (maxRangeExceeded) continue;

        if (
          breakout.close > mother.high &&
          breakout.low > mother.low &&
          breakout.close > breakout.open &&
          breakout.open !== breakout.low &&
          confirm.high > breakout.high &&
          confirm.low > breakout.low
        ) {
          try {
            console.log(`bullish inside bar on ${symbol}`);
            const historical = await this.getRestClient('68d3f007099f9de77119b413').getKlines({
              symbol,
              interval: interval as any,
              limit: maxCandles,
              endTime: mother.startTime - 1
            });
            const prev = historical.map((k: any) => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              startTime: Number(k[0]),
              isFinal: true
            }));
            const baseWindows = [60];
            const checkWindows = baseWindows.map(w => Math.ceil(w / intervalMin));
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const minLow = Math.min(...checkPrev.map((c: any) => c.low));
              const patternLow = mother.low;
              if (minLow > patternLow) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (
                  volumeTf
                   && await this.hasHigherTFConfirmation(symbol, 'BUY')
                ) {
                  const sl = patternLow;
                  const tp = confirm.close + 400 * (confirm.close - sl);
               
                  await this.placeFullOrder({
                    userId: '68d3f007099f9de77119b413',
                    symbol,
                    side: 'BUY',
                    type: 'MARKET',
                    stopLoss: sl,
                    takeProfit: tp,
                   isScalping: false,
                      isAlgoEntry: true
                  });
                  console.log(`BULLISH INSIDE BAR LONG entered: ${symbol}`);
                  return;
                }
              }
            }
          } catch (e) {
            console.error(e);
          }
        }

        if (
           breakout.close < mother.low &&
        breakout.high < mother.high &&
        breakout.close < breakout.open &&
        breakout.open !== breakout.high &&
        confirm.low < breakout.low &&
        confirm.high < breakout.high
        ) {
          try {
            console.log(`bearish inside bar on ${symbol}`);
            const historical = await this.getRestClient('68d3f007099f9de77119b413').getKlines({
              symbol,
              interval: interval as any,
              limit: maxCandles,
              endTime: mother.startTime - 1
            });
            const prev = historical.map((k: any) => ({
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              startTime: Number(k[0]),
              isFinal: true
            }));
            const baseWindows = [60];
            const checkWindows = baseWindows.map(w => Math.ceil(w / intervalMin));
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const maxHigh = Math.max(...checkPrev.map((c: any) => c.high));
              const patternHigh = mother.high;
              if (maxHigh < patternHigh) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (
                  volumeTf
                    && await this.hasHigherTFConfirmation(symbol, 'SELL')
                  )
                  
                  {
                  const sl = patternHigh;
                  const tp = confirm.close - 400 * (sl - confirm.close);
                 
                  await this.placeFullOrder({
                    userId: '68d3f007099f9de77119b413',
                    symbol,
                    side: 'SELL',
                    type: 'MARKET',
                    stopLoss: sl,
                    takeProfit: tp,
                    isScalping: false,
                      isAlgoEntry: true
                  });
                  console.log(`BEARISH INSIDE BAR SHORT entered: ${symbol}`);
                  return;
                }
              }
            }
          } catch (e) {
            console.error(e);
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
    return lowerShadow >= 1.5 * body && upperShadow <= 0.4 * Math.max(body, 1e-8) && lowerShadow / range >= 0.55 && c.close > c.open;
  }

  private isInverseHammer(c: any): boolean {
    const body = Math.abs(c.close - c.open);
    const upperShadow = c.high - Math.max(c.open, c.close);
    const lowerShadow = Math.min(c.open, c.close) - c.low;
    const range = c.high - c.low || 1e-8;
    return upperShadow >= 1.5 * body && lowerShadow <= 0.4 * Math.max(body, 1e-8) && upperShadow / range >= 0.55 && c.close < c.open;
  }

  private isBullishSpinningTop(c: any): boolean {
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
   private getMaxRangePercent(interval: string): number {
    switch (interval) {
      case '1m': return 0.005;
      case '5m': return 0.015;
      case '15m': return 0.025;
      case '1h': return 0.035;
      case '2h': return 0.08;
      case '4h': return 0.12;
      case '1d': return 0.15;
      default: return 0.035;
    }
  }


  private async checkVolumeIncrease(symbol: string): Promise<string | null> {
    const intervals = ['1d', '12h', '6h', '4h', '2h', '1h'];
    for (const interval of intervals) {
      const now = new Date().getTime();
      const intervalMs = this.getIntervalMs(interval);
      const currentCandleStart = Math.floor(now / intervalMs) * intervalMs;
      const endTime = currentCandleStart - 1;
      try {
        const rest = this.getRestClient('68d3f007099f9de77119b413');
        const historical = await rest.getKlines({
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
        console.error(e);
        continue;
      }
    }
    return null;
  }

  private getIntervalMs(interval: string): number {
    if (interval === '1d') return 24 * 60 * 60 * 1000;
    const hours = parseInt(interval.replace('h', ''));
    return hours * 60 * 60 * 1000;
  }

  private async hasHigherTFConfirmation(symbol: string, side: 'BUY' | 'SELL'): Promise<boolean> {
    const isBullish = side === 'BUY';
    const tfs = ['1h', '2h', '4h', '1d'];
    for (const tf of tfs) {
      if (await this.hasSamePatternInHigherTF(symbol, tf, isBullish)) return true;
    }
    return false;
  }


  private async hasSamePatternInHigherTF(symbol: string, interval: string, wantBullish: boolean): Promise<boolean> {
      console.log(`checking higher tf ${interval} for ${symbol} bullish=${wantBullish}`);
    try {
      const rest = this.getRestClient('68d3f007099f9de77119b413');
      const klines = await rest.getKlines({ symbol, interval: interval as any, limit: 16 });
      if (klines.length < 15) return false;
      const candles = klines.map(k => ({
        open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), startTime: Number(k[0])
      }));
       const currentPrice = this.candles1m[symbol]?.[this.candles1m[symbol].length - 1]?.close || 0;
      const maxPercent = this.getMaxRangePercent(interval);
      for (let i = 4; i < candles.length; i++) {
        const c1 = candles[i-3];
        const c2 = candles[i-2];
        const c3 = candles[i-1];
        const c4 = candles[i];
        if ([c1, c2, c3, c4].some(c => (c.high - c.low) / c.low > maxPercent)) continue;
        let patternFound = false;
        let patternLow = 0;
        let patternHigh = 0;
        let firstCandleLow = 0;
        let firstCandleHigh = 0;
        if (wantBullish && this.isHammer(c1) &&
              c2.low !== c2.open && c2.close > c1.high &&
            c3.high > c2.high && c3.low > c2.low && c2.low > c1.low && 
          currentPrice > c2.low && currentPrice < c3.high
          ) {
          patternFound = true;
          patternLow = c2.low;
          firstCandleLow = c1.low;
        }
        if (!wantBullish && this.isInverseHammer(c1) &&
            c2.high !== c2.open && c2.close < c1.low &&
            c3.low < c2.low && c3.high < c2.high && c2.high < c1.high &&
          currentPrice < c2.high && currentPrice > c3.low
          ) {
          patternFound = true;
          patternHigh = c2.high;
          firstCandleHigh = c1.high;
        }
        if (wantBullish && this.isBullishSpinningTop(c1) &&
            c2.low !== c2.open && c2.close > c1.high &&
            c3.high > c2.high && c3.low > c2.low && c2.low > c1.low &&
          currentPrice > c2.low && currentPrice < c3.high
          ) {
          patternFound = true;
          patternLow = c2.low;
          firstCandleLow = c1.low;
        }
        if (!wantBullish && this.isBearishSpinningTop(c1) &&
            c2.high !== c2.open && c2.close < c1.low &&
            c3.low < c2.low && c3.high < c2.high && c2.high < c1.high &&
              currentPrice < c2.high && currentPrice > c3.low
          ) {
          patternFound = true;
          patternHigh = c2.high;
          firstCandleHigh = c1.high;
        }
        if (wantBullish &&
             c1.close < c1.open && c2.open <= c1.close &&
            c2.low < c1.low && c2.high > c1.high && c2.close > c1.open &&
            c3.low > c2.low && c3.close > c2.high && c3.close > c3.open &&
            c4.high > c3.high && c4.low > c3.low &&
            c3.open !== c3.low &&
            currentPrice > c3.low && currentPrice < c4.high
          ) {
          patternFound = true;
          patternLow = c3.low;
          firstCandleLow = c1.low;
        }
        if (!wantBullish &&
            c1.close > c1.open && c2.open >= c1.close &&
            c2.low < c1.low && c2.high > c1.high && c2.close < c1.open &&
            c3.high < c2.high && c3.close < c2.low && c3.close < c3.open &&
            c4.low < c3.low && c4.high < c3.high &&
            c3.open !== c3.high &&
            currentPrice < c3.high && currentPrice > c4.low
          ) {
          patternFound = true;
          patternHigh = c3.high;
          firstCandleHigh = c1.high;
        }
        if (wantBullish &&
            c1.close < c1.open && c2.low > c1.low && c2.high < c1.high &&
            c2.open >= c1.close && c2.close <= c1.open && c2.close > c2.open &&
            c3.close > c3.open && c3.close > c1.high && c3.low > c2.low &&
            c4.high > c3.high && c4.low > c3.low &&
            c3.open !== c3.low &&
          currentPrice > c3.low && currentPrice < c4.high
          ) {
          patternFound = true;
          patternLow = c3.low;
          firstCandleLow = c1.low;
        }
        if (!wantBullish &&
            c1.close > c1.open && c2.low > c1.low && c2.high < c1.high &&
            c2.open <= c1.close && c2.close >= c1.open && c2.close < c2.open &&
            c3.close < c3.open && c3.close < c1.low && c3.high < c2.high &&
            c4.low < c3.low && c4.high < c3.high &&
            c3.open !== c3.high &&
              currentPrice < c3.high && currentPrice > c4.low
          ) {
          patternFound = true;
          patternHigh = c3.high;
          firstCandleHigh = c1.high;
        }


       
if (patternFound) {
//  console.log(`Pattern  detected on ${symbol} at ${new Date(candles[i - 3].startTime).toISOString()} in ${interval}`);
 // const historyStart = i - 3 - 3;
  const historyStart = i - 3 - 5;
  if (historyStart < 0) {
   // console.log(`History fail: Not enough candles (need 5 before pattern)`);
    continue;
  }
  const historyCandles = candles.slice(historyStart, i - 3);
 // console.log(`History candles count: ${historyCandles.length}, from index ${historyStart} to ${i-3}`);
  if (wantBullish) {
    const minLow = Math.min(...historyCandles.map(c => c.low));
   // console.log(`Bullish - minLow in history: ${minLow}, patternLow: ${firstCandleLow}`);
    if (minLow <= firstCandleLow) {
     // console.log(`History fail: lower low found (${minLow} <= ${firstCandleLow})`);
      continue;
    }
  } else {
    const maxHigh = Math.max(...historyCandles.map(c => c.high));
   // console.log(`Bearish - maxHigh in history: ${maxHigh}, patternHigh: ${firstCandleHigh}`);
    if (maxHigh >= firstCandleHigh) {
     // console.log(`History fail: higher high found (${maxHigh} >= ${firstCandleHigh})`);
      continue;
    }
  }

  const postStart = i + 1;
  if (postStart < candles.length) {
    const postCandles = candles.slice(postStart);
   // console.log(`Post candles count: ${postCandles.length}, from index ${postStart}`);
    if (wantBullish) {
      const minPostLow = Math.min(...postCandles.map(c => c.low));
     // console.log(`Bullish - minPostLow: ${minPostLow}, patternLow: ${patternLow}`);
      if (minPostLow < patternLow) {
      //  console.log(`Post fail: lower low in post candles (${minPostLow} < ${patternLow})`);
        continue;
      }
    } else {
      const maxPostHigh = Math.max(...postCandles.map(c => c.high));
     // console.log(`Bearish - maxPostHigh: ${maxPostHigh}, patternHigh: ${patternHigh}`);
      if (maxPostHigh > patternHigh) {
        // console.log(`Post fail: higher high in post candles (${maxPostHigh} > ${patternHigh})`);
        continue;
      }
    }
  }
 // console.log(`All checks passed → returning true for `);
  return true;
}



        for (let numInside = 5; numInside >= 1; numInside--) {
          const motherIndex = i - (numInside + 1);
          if (motherIndex < 0) continue;
          const mother = candles[motherIndex];
          let allInside = true;
          for (let j = 1; j <= numInside; j++) {
            const insideC = candles[motherIndex + j];
            if (!(insideC.high <= mother.high && insideC.low >= mother.low)) {
              allInside = false;
              break;
            }
          }
          if (!allInside) continue;
          const breakout = candles[i - 1];
          const confirm = candles[i];
          let maxRangeExceeded = false;
          for (let k = 0; k <= numInside + 2; k++) {
            const c = candles[motherIndex + k];
            if ((c.high - c.low) / c.low > maxPercent) {
              maxRangeExceeded = true;
              break;
            }
          }
          if (maxRangeExceeded) continue;
          if (wantBullish &&
                breakout.close > mother.high &&
          breakout.low > mother.low &&
          breakout.close > breakout.open &&
          breakout.open !== breakout.low &&
          confirm.high > breakout.high &&
          confirm.low > breakout.low &&
         currentPrice > breakout.low && currentPrice < confirm.high
            ) {
            patternFound = true;
            patternLow = breakout.low;
             firstCandleLow = mother.low;
          }
          if (!wantBullish &&
              breakout.close < mother.low &&
        breakout.high < mother.high &&
        breakout.close < breakout.open &&
        breakout.open !== breakout.high &&
        confirm.low < breakout.low &&
        confirm.high < breakout.high &&
         currentPrice < breakout.high && currentPrice > confirm.low) {
            patternFound = true;
            patternHigh = breakout.high;
             firstCandleHigh = mother.high;
          }



         
if (patternFound) {
 // console.log(`Pattern  detected on ${symbol} at ${new Date(mother.startTime).toISOString()} in ${interval}`);
  //const historyStart = motherIndex - 3;
  const historyStart = motherIndex - 5;
  if (historyStart < 0) {
   // console.log(`Inside Bar History fail: Not enough candles (need 5 before mother)`);
    continue;
  }
  const historyCandles = candles.slice(historyStart, motherIndex);
 // console.log(`Inside Bar History candles count: ${historyCandles.length}, from ${historyStart} to ${motherIndex-1}`);
  if (wantBullish) {
    const minLow = Math.min(...historyCandles.map(c => c.low));
   // console.log(`Bullish Inside - minLow: ${minLow}, patternLow: ${firstCandleLow}`);
    if (minLow <= firstCandleLow) {
     // console.log(`Inside Bar History fail: lower low found (${minLow} <= ${firstCandleLow})`);
      continue;
    }
  } else {
    const maxHigh = Math.max(...historyCandles.map(c => c.high));
   // console.log(`Bearish Inside - maxHigh: ${maxHigh}, patternHigh: ${firstCandleHigh}`);
    if (maxHigh >= firstCandleHigh) {
     // console.log(`Inside Bar History fail: higher high found (${maxHigh} >= ${firstCandleHigh})`);
      continue;
    }
  }

  const postStart = i + 1;
  if (postStart < candles.length) {
    const postCandles = candles.slice(postStart);
   // console.log(`Inside Bar Post candles count: ${postCandles.length}, from ${postStart}`);
    if (wantBullish) {
      const minPostLow = Math.min(...postCandles.map(c => c.low));
    //  console.log(`Bullish Inside - minPostLow: ${minPostLow}, patternLow: ${patternLow}`);
      if (minPostLow < patternLow) {
       // console.log(`Inside Bar Post fail: lower low in post (${minPostLow} < ${patternLow})`);
        continue;
      }
    } else {
      const maxPostHigh = Math.max(...postCandles.map(c => c.high));
     // console.log(`Bearish Inside - maxPostHigh: ${maxPostHigh}, patternHigh: ${patternHigh}`);
      if (maxPostHigh > patternHigh) {
        //console.log(`Inside Bar Post fail: higher high in post (${maxPostHigh} > ${patternHigh})`);
        continue;
      }
    }
  }
 // console.log(`Inside Bar all checks passed → return true`);
  return true;
}
    }
      }
      return false;
    } catch {
      return false;
    }
  }


  private isOurBotOrder(clientId: string | undefined): boolean {
    if (!clientId) return false;
    return clientId.startsWith(this.OUR_CLIENT_PREFIX) && (
      clientId.includes('_en-') || clientId.includes('_sl-') || clientId.includes('_tp-') || clientId.includes('_co-')
    );
  }

  private lastEventId = new Map<string, string>();

  private async onUserDataEvent(userId: string, data: any) {
    if (data.eventId && this.lastEventId.get(userId) === data.eventId) return;
    if (data.eventId) this.lastEventId.set(userId, data.eventId);
    if (data.eventType === 'ORDER_TRADE_UPDATE') {
      const o = data.order;
      const clientId = o.clientOrderId || '';
      if ( ( !this.isOurBotOrder(o.clientOrderId) && o.executionType === 'TRADE' &&
        o.orderStatus === 'FILLED') || ( o.strategyType === 'ALGO_CONDITION' && o.executionType === 'TRADE' &&
        o.orderStatus === 'FILLED') || (
       (clientId.startsWith('x-15PC4ZJy_Xcdr_tp-') || clientId.startsWith('x-15PC4ZJy_Xcdr_sl-')) &&
        o.orderStatus === 'FILLED' && o. executionType === 'TRADE' &&
        (o. originalOrderType === 'STOP_MARKET' || o. originalOrderType === 'TAKE_PROFIT_MARKET'))
    ) {
        const uniqueKey = `${userId}-${o.symbol}-${clientId}-${o.origQty}-${o.orderId}`;
        if (this.processingClose.has(uniqueKey)) {
          console.log(`[${userId}] DUPLICATE IGNORED → ${o.symbol} ${clientId}`);
          return;
        }
        this.processingClose.set(uniqueKey, true);
        console.log(`[${userId}] UNWANTED ENTRY → ${o.symbol} ${o.side} ${clientId} → KILLING`);
        setTimeout(() => {
          this.closeUnwantedPosition(userId, o.symbol).catch(err =>
            console.error(`[${userId}] Delayed unwanted close failed`, err)
          );
        }, 3000);

        if (clientId) {
          for (const [key, state] of this.trailingState.entries()) {
            if (state.slClientId === clientId || state.tpClientId === clientId) {
              this.trailingState.delete(key);
              break;
            }
          }
        }
      }

      if( (o.originalOrderType === 'STOP_MARKET' || o.originalOrderType === 'TAKE_PROFIT_MARKET'|| o.strategyType === 'ALGO_CONDITION' )
      ) {
        const marginAddKey = `${userId}-marginadd-${o.orderId}`;
        if (this.processedMarginAdds?.has(marginAddKey)) {
        } else {
          this.processedMarginAdds ??= new Set();
          this.processedMarginAdds.add(marginAddKey);
          const originalQty = Number(o.originalQuantity);
          const filledQty = Number(o.lastFilledQuantity);
          const realisedRaw = Number(o.realisedProfit);
          const commission = Number(o.commissionAmount);
          let amountToAdd = 0;
          if (originalQty === filledQty) {
            amountToAdd = Math.abs(realisedRaw) + commission;
          } else {
            const scale = originalQty / filledQty;
            amountToAdd = Math.abs(realisedRaw) * scale + commission * scale;
          }
          if (amountToAdd > 0.005) {
            setTimeout(async () => {
              try {
                const rest = this.getRestClient(userId);
                const positions = await rest.getPositionsV3();
                const pos = positions.find((p: any) =>
                  p.symbol === o.symbol &&
                  p.positionSide === o.positionSide &&
                  Math.abs(parseFloat(p.positionAmt)) > 0.1
                );
                if (pos) {
                  await rest.setIsolatedPositionMargin({
                    symbol: o.symbol,
                    positionSide: o.positionSide as 'LONG' | 'SHORT',
                    amount: amountToAdd,
                    type: "1"
                  });
                  console.log(`AUTO MARGIN ADDED → ${o.symbol} ${o.positionSide} | +${amountToAdd.toFixed(2)})`);
                  this.processedMarginAdds.delete(marginAddKey);
                }
              } catch (err: any) {
                console.error(`[${userId}] AUTO MARGIN ADD FAILED → ${o.symbol}`, err.message);
                this.processedMarginAdds.delete(marginAddKey);
              }
            }, 2000);
          } else{
            this.processedMarginAdds.delete(marginAddKey);
          }
        }
      }
    }

    switch (data.eventType) {
      case 'balanceUpdate':
        console.log('Balance Update:', data);
        break;
      case 'executionReport':
        console.log('Execution Report:', data);
        break;
      case 'listStatus':
        console.log('List Status:', data);
        break;
      case 'listenKeyExpired':
        console.log('Listen Key Expired:', data);
        break;
      case 'outboundAccountPosition':
        console.log('Outbound Account Position:', data);
        break;
      case 'ACCOUNT_CONFIG_UPDATE':
        console.log('Account Config Update:', data);
        break;
      case 'ACCOUNT_UPDATE':
        break;
      case 'MARGIN_CALL':
        console.log('Margin Call:', data);
        break;
      case 'ORDER_TRADE_UPDATE':
        break;
      case 'CONDITIONAL_ORDER_TRIGGER_REJECT':
        break;
      case 'kline':
        break;
      case 'markPriceUpdate':
        break;
      case 'liquidationOrder':
        console.log('Liquidation Order:', data);
        break;
      case '24hrTicker':
        console.log('24hr Ticker Update:', data);
        break;
      default:
        break;
    }
  }

  private async executeTrail(userId: string, key: string, state: any, currentPrice: number) {
    const oldkey = key;
    console.log("we recieve signal to trail:",oldkey,currentPrice,state);
    const rest = this.getRestClient(userId);
    const symbol = state.symbol;
    const positionSide = state.positionSide;
    const qty = state.qty;
    const side = state.side;
    console.log(oldkey,symbol,positionSide,qty,side);
    let oldSlExists = false;
    let oldTpExists = false;
    try {
      const openOrders = await rest.getOpenAlgoOrders(symbol ? { symbol } : undefined)
      for (const o of openOrders) {
        if (o.clientAlgoId === state.slClientId) oldSlExists = true;
        if (o.clientAlgoId === state.tpClientId) oldTpExists = true;
      }
    } catch (e) {
    }
    if (!oldSlExists && !oldTpExists) {
      this.trailingState.delete(oldkey);
      return;
    }
    const precision = await this.getSymbolPrecision(symbol);
    const rootClientId = uuidv4().replace(/-/g, '').substring(0, 14);
    const newSlId = `${this.OUR_CLIENT_PREFIX}_sl-${rootClientId}`;
    const newTpId = `${this.OUR_CLIENT_PREFIX}_tp-${rootClientId}`;
    const isScalping = state.isScalping;
    const triggerMul = isScalping ? 1.03 : 1.05;
    const moveMul = isScalping ? 1.01 : 1.02;
    const BigTriggerMul = isScalping ? 1.25 : 1.34;
    const BigMoveMul = isScalping ? 1.18 : 1.26;
    const isLong = side === 'BUY';
    const isBigMove = isLong ? currentPrice >= state.bigMoveTriggerPrice : currentPrice <= state.bigMoveTriggerPrice;
    const newSlTrigger = isBigMove ? state.bigMoveNextSL : state.nextSL;
    const newTpTrigger = isBigMove ? state.bigMoveNextTP : state.nextTP;
    const betterSL = isLong ? (newSlTrigger > state.currentSL) : (newSlTrigger < state.currentSL);
    const betterTP = isLong ? (newTpTrigger > state.currentTP) : (newTpTrigger < state.currentTP);
    if (betterSL && betterTP) {
      let slOk = true;
      try {
        await this.placeOrder(userId, {
          symbol,
          side: side === 'BUY' ? 'SELL' : 'BUY',
          type: 'STOP_MARKET',
          triggerPrice: newSlTrigger,
          quantity: qty,
          timeInForce: 'GTE_GTC',
          workingType: 'MARK_PRICE',
          priceProtect: 'TRUE',
          closePosition: 'false',
          positionSide,
          newClientOrderId: newSlId
        });
      } catch (e) { slOk = false; console.error(`SL failed`, e); }
      if (slOk) try { await rest.cancelAlgoOrder({ clientAlgoId: state.slClientId }); } catch {}
      let tpOk = true;
      try {
        await this.placeOrder(userId, {
          symbol,
          side: side === 'BUY' ? 'SELL' : 'BUY',
          type: 'TAKE_PROFIT_MARKET',
          triggerPrice: newTpTrigger,
          quantity: qty,
          timeInForce: 'GTE_GTC',
          workingType: 'MARK_PRICE',
          priceProtect: 'TRUE',
          closePosition: 'false',
          positionSide,
          newClientOrderId: newTpId
        });
      } catch (e) { tpOk = false; console.error(`TP failed`, e); }
      if (tpOk) try { await rest.cancelAlgoOrder({ clientAlgoId: state.tpClientId }); } catch {}
      if (slOk && tpOk) {
        const newKey = `${userId}-${symbol}-${positionSide}-${side}-${newSlId}-${newTpId}`;
        const newCurrentSL = newSlTrigger;
        const newCurrentTP = newTpTrigger;
        let newBigMoveTriggerPrice = state.bigMoveTriggerPrice;
        let newBigMoveNextSL = state.bigMoveNextSL;
        let newBigMoveNextTP = state.bigMoveNextTP;
        if (isBigMove) {
          newBigMoveTriggerPrice = this.round(isLong ? newCurrentSL * BigTriggerMul : newCurrentSL / BigTriggerMul, precision.pricePrecision);
          newBigMoveNextSL = this.round(isLong ? newCurrentSL * BigMoveMul : newCurrentSL / BigMoveMul, precision.pricePrecision);
          newBigMoveNextTP = this.round(isLong ? newCurrentTP * BigMoveMul : newCurrentTP / BigMoveMul, precision.pricePrecision);
        }
        this.trailingState.set(newKey, {
          ...state,
          currentSL: newCurrentSL,
          currentTP: newCurrentTP,
          trailCount: state.trailCount + 1,
          nextTriggerPrice: this.round(isLong ? newCurrentSL * triggerMul : newCurrentSL / triggerMul, precision.pricePrecision),
          nextSL: this.round(isLong ? newCurrentSL * moveMul : newCurrentSL / moveMul, precision.pricePrecision),
          nextTP: this.round(isLong ? newCurrentTP * moveMul : newCurrentTP / moveMul, precision.pricePrecision),
          bigMoveTriggerPrice: newBigMoveTriggerPrice,
          bigMoveNextSL: newBigMoveNextSL,
          bigMoveNextTP: newBigMoveNextTP,
          slClientId: newSlId,
          tpClientId: newTpId
        });
        this.trailingState.delete(oldkey);
      }
    } else {
      state.nextTriggerPrice = this.round(isLong ? state.currentSL * triggerMul : state.currentSL / triggerMul, precision.pricePrecision);
      state.nextSL = this.round(isLong ? state.currentSL * moveMul : state.currentSL / moveMul, precision.pricePrecision);
      state.nextTP = this.round(isLong ? state.currentTP * moveMul : state.currentTP / moveMul, precision.pricePrecision);
      if (isBigMove) {
        state.bigMoveTriggerPrice = this.round(isLong ? state.currentSL * BigTriggerMul : state.currentSL / BigTriggerMul, precision.pricePrecision);
        state.bigMoveNextSL = this.round(isLong ? state.currentSL * BigMoveMul : state.currentSL / BigMoveMul, precision.pricePrecision);
        state.bigMoveNextTP = this.round(isLong ? state.currentTP * BigMoveMul : state.currentTP / BigMoveMul, precision.pricePrecision);
      }
    }
  }

  private async closeUnwantedPosition(userId: string, symbol: string) {
    try {
      const rest = this.getRestClient(userId);
      const allPos = (await rest.getPositionsV3())
        .filter((p: any) => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt || '0')) > 0.0001);
      if (!allPos.length) return;
      const normalOpenOrders = await rest.getAllOpenOrders({ symbol });
      const algoOpenOrders = await rest.getOpenAlgoOrders({ symbol });
      const openOrders = [
        ...normalOpenOrders.map(o => ({ ...o, isAlgo: false })),
        ...algoOpenOrders.map(o => ({
          ...o,
          isAlgo: true,
          clientOrderId: o.clientAlgoId,
          type: o.orderType,
          origQty: o.quantity,
          stopPrice: o.triggerPrice,
          orderId: o.algoId
        }))
      ];
      const getBaseId = (id: string): string => {
        const match = id.match(/_(?:sl|tp)-([a-z0-9]{7})/i);
        return match ? match[1] : ''; 
      };
      for (const pos of allPos) {
        const positionSide = pos.positionSide;
        const currentQty = Number(pos.positionAmt);
        const closeSide = currentQty > 0 ? 'SELL' : 'BUY';
        const absQty = Math.abs(currentQty);
        let validQtyFromBot = 0;
        const validBaseIds = new Set<string>();
        const slOrders = openOrders.filter((o: any) =>
          o.type === 'STOP_MARKET' && o.positionSide === positionSide && this.isOurBotOrder(o.clientOrderId) );
        for (const sl of slOrders) {
          const baseId = getBaseId(sl.clientOrderId);
          const matchingTp = openOrders.find((o: any) =>
            o.type === 'TAKE_PROFIT_MARKET' &&
            o.positionSide === positionSide &&
            this.isOurBotOrder(o.clientOrderId) &&
            getBaseId(o.clientOrderId) === baseId &&
            Number(o.origQty) === Number(sl.origQty)
          );
          if (matchingTp) {
            validQtyFromBot += Number(sl.origQty);
            validBaseIds.add(baseId);
          }
        }
        console.log(`[${userId}] ${symbol} ${positionSide} | Position: ${currentQty} | Valid Bot PAIR Qty: ${validQtyFromBot}`);
        const ghostOrders = openOrders.filter((o: any) =>
          ['STOP_MARKET', 'TAKE_PROFIT_MARKET'].includes(o.type) &&
          o.positionSide === positionSide &&
          ( !this.isOurBotOrder(o.clientOrderId) || !validBaseIds.has(getBaseId(o.clientOrderId)) )
        );
        for (const order of ghostOrders) {
          console.log(`[${userId}] CANCEL USER GHOST SL/TP → ${order.clientOrderId} (${order.type}) Qty:${order.origQty}`);
          if (order.isAlgo) {
            await rest.cancelAlgoOrder({ clientAlgoId: order.clientOrderId }).catch(() => {});
          } else {
            await rest.cancelOrder({ symbol, orderId: order.orderId }).catch(() => {});
          } 
        }
        const excessQty = absQty - validQtyFromBot;
        if (excessQty <= 0.0001) {
          console.log(`[${userId}] No excess qty on ${symbol} ${positionSide}, only cleaned ghost orders`);
          continue;
        }
        const rootClientId = uuidv4().replace(/-/g, '').substring(0, 14);
        const closeClientId = `${this.OUR_CLIENT_PREFIX}_co-${rootClientId}`;
        const rrrr = await this.placeOrder(userId, {
          symbol,
          side: closeSide,
          type: 'MARKET',
          quantity: excessQty.toFixed(5),
          positionSide: positionSide as 'LONG' | 'SHORT' | 'BOTH',
          newClientOrderId: closeClientId,
          closePosition: 'false'
        });
      }
    } catch (e) {
    } finally {
      const prefix = `${userId}-${symbol}-`;
      for (const key of [...this.processingClose.keys()]) {
        if (key.startsWith(prefix)) {
          this.processingClose.delete(key);
        }
      }
    }
  }

  private async restoreBotStateOnStartup(userId: string) {
    try {
      const rest = this.getRestClient(userId);
      const positions = await rest.getPositionsV3();
      const normalOpenOrders = await rest.getAllOpenOrders({});
      const algoOpenOrders = await rest.getOpenAlgoOrders({});
      const openOrders = [
        ...normalOpenOrders.map(o => ({ ...o, isAlgo: false })),
        ...algoOpenOrders.map(o => ({
          ...o,
          isAlgo: true,
          clientOrderId: o.clientAlgoId,
          type: o.orderType,
          origQty: o.quantity,
          stopPrice: o.triggerPrice,
          orderId: o.algoId
        }))
      ];
      const getBaseId = (id: string): string => {
        const match = id.match(/_(?:sl|tp)-([a-z0-9]{7})/i);
        return match ? match[1] : '';
      };
      for (const pos of positions) {
        const rawAmt = pos.positionAmt || '0';
        if (Math.abs(parseFloat(rawAmt as string)) < 0.0001) continue;
        const symbol = pos.symbol;
        const positionSide = pos.positionSide as 'LONG' | 'SHORT' | 'BOTH';
        const side = positionSide === 'LONG' ? 'BUY' : 'SELL';
        const precision = await this.getSymbolPrecision(symbol);
        const botSlOrders = openOrders.filter(o =>
          o.symbol === symbol &&
          o.positionSide === positionSide &&
          o.type === 'STOP_MARKET' &&
          this.isOurBotOrder(o.clientOrderId)
        );
        for (const ourSL of botSlOrders) {
          const baseId = getBaseId(ourSL.clientOrderId);
          const ourTP = openOrders.find(o =>
            o.symbol === symbol &&
            o.positionSide === positionSide &&
            o.type === 'TAKE_PROFIT_MARKET' &&
            this.isOurBotOrder(o.clientOrderId) &&
            getBaseId(o.clientOrderId) === baseId &&
            o.origQty === ourSL.origQty
          );
          if (!ourTP) continue;
          const currentSL = Number(ourSL.stopPrice);
          const currentTP = Number(ourTP.stopPrice);
          const qty = ourSL.origQty;
          const key = `${userId}-${symbol}-${positionSide}-${side}-${ourSL.clientOrderId}-${ourTP.clientOrderId}`;
          const isScalping = false;
          const firstTriggerMul = isScalping ? 1.04 : 1.05;
          const firstMoveMul = isScalping ? 1.02 : 1.012;
          const triggerMul = isScalping ? 1.25 : 1.34;
          const moveMul = isScalping ? 1.18 : 1.25;
          this.trailingState.set(key, {
            side,
            symbol,
            positionSide: positionSide as any,
            currentSL,
            currentTP,
            qty,
            trailCount: 0,
            isScalping,
            nextTriggerPrice: this.round(
              side === 'BUY' ? currentSL * firstTriggerMul : currentSL / firstTriggerMul,
              precision.pricePrecision ),
            nextSL: this.round(
              side === 'BUY' ? currentSL * firstMoveMul : currentSL / firstMoveMul,
              precision.pricePrecision ),
            nextTP: this.round(
              side === 'BUY' ? currentTP * firstMoveMul : currentTP / firstMoveMul,
              precision.pricePrecision),
            bigMoveTriggerPrice: this.round(
              side === 'BUY' ? currentSL * triggerMul : currentSL / triggerMul,
              precision.pricePrecision),
            bigMoveNextSL: this.round(
              side === 'BUY' ? currentSL * moveMul : currentSL / moveMul,
              precision.pricePrecision ),
            bigMoveNextTP: this.round(
              side === 'BUY' ? currentTP * moveMul : currentTP / moveMul,
              precision.pricePrecision ),
            slClientId: ourSL.clientOrderId,
            tpClientId: ourTP.clientOrderId
          });
          console.log(`[${userId}] TRAILING RESTORED → ${symbol} ${positionSide} | Mode: ${isScalping ? 'SCALPING (1.5%→0.3%)' : 'SWING (2%→0.4%)'}`);
        }
      }
      const allSymbols = [...new Set(positions.map(p => p.symbol))];
      for (const symbol of allSymbols) {
        setTimeout(() => this.closeUnwantedPosition(userId, symbol).catch(() => {}), 2000);
      }
      console.log(`[${userId}] Bot state fully restored — trailing active on all positions`);
    } catch (err) {
      console.error(`[${userId}] Failed to restore state on startup`, err);
    }
  }

  private async placeOrder(
    userId: string,
    params: {
      symbol: string;
      side: 'BUY' | 'SELL';
      type: 'MARKET' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
      quantity: string | number;
      price?: string | number;
      triggerPrice?: string | number;
      workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE';
      priceProtect?: 'TRUE' | 'FALSE';
      timeInForce?: 'GTC' | 'GTE_GTC';
      positionSide: 'LONG' | 'SHORT' | 'BOTH';
      newClientOrderId?: string;
      closePosition?: 'true' | 'false';
    }
  ) {
    const restClient = this.getRestClient(userId);
    const baseParams: any = {
      symbol: params.symbol,
      side: params.side,
      positionSide: params.positionSide,
      quantity: params.quantity.toString(),
      timestamp: Date.now() + this.serverTimeOffset,
    };
    if (params.newClientOrderId) baseParams.newClientOrderId = params.newClientOrderId;
    if (params.timeInForce && params.triggerPrice !== undefined) baseParams.stopPrice = params.triggerPrice.toString();
    if (params.workingType) baseParams.workingType = params.workingType;
    if (params.priceProtect) baseParams.priceProtect = params.priceProtect;
    if (params.timeInForce) baseParams.timeInForce = params.timeInForce;
    if (params.closePosition) baseParams.closePosition = params.closePosition;
    if (params.type === 'MARKET') {
      baseParams.type = 'MARKET';
      return await restClient.submitNewOrder(baseParams);
    }
    if (params.type === 'STOP_MARKET' || params.type === 'TAKE_PROFIT_MARKET') {
      baseParams.type = params.type;
      if (params.triggerPrice !== undefined) {
        baseParams.triggerPrice = params.triggerPrice.toString();
      }
      baseParams.algoType = 'CONDITIONAL';
      baseParams.clientAlgoId = params.newClientOrderId || uuidv4().slice(0, 32);
      return await restClient.submitNewAlgoOrder(baseParams);
    }
    throw new Error(`Unsupported order type: ${params.type}`);
  }

  private getRestClient(userId: string): USDMClient {
    const client = this.userRestClients.get(userId);
    if (!client) throw new Error(`REST client missing for ${userId}`);
    return client;
  }

  private getUserState(userId: string): UserBotState {
    if (!this.userStates.has(userId)) {
      this.userStates.set(userId, {
        restingMode: { enabled: false, until: 0, duration: 0 },
        burstModeEnabled: false,
        burstEntriesLeft: 0,
        burstUsesToday: 0,
        lastBurstActivationTime: null,
        dailyEntryCount: 0,
        lastEntryTime: null,
        lastResetDate: null,
        slTracker: new Map(),
        config: this.getUserConfig(userId),
        ourClientPrefixes: new Set([this.OUR_CLIENT_PREFIX]),
        symbolEntryCounts: new Map<string, number>(),
      });
    }
    return this.userStates.get(userId)!;
  }

  private getUserConfig(userId: string): UserTradingConfig {
    const configs: Record<string, UserTradingConfig> = {
      '68d3f007099f9de77119b413': {
        API_KEY: 'iTJJoBOzgW8YejbaFtyGbbLxxDrzeeM6z5IiyAZXzc7j92UqEHchnI19qnuXLEaj',
        API_SECRET: 'SjJihZC0OfVvcmJBkW6lZRHPxp7IMTr1ncMsUHJONfrUHaVDnjldIcGPU77l5WhT',
        RISK_PERCENT: 0.4,
        LEVERAGE: 15,
        MARGIN_TYPE: 'ISOLATED',
        HEDGE_MODE: true,
      },
      'sub1-68d3f007099f9de77119b413': { API_KEY: 'xhvQqDNyh7StyCrKc8cCkdyycJKcyZBHZjndkuuuWXjs8RqY9KSbqIK9hH0Yt7rI', API_SECRET: 'aZSNaQaI4b4Qz021jQnY1VepO7aRIkHDljXyy2WdcdvC0Ih2FonURmJ9F0sbLe2von', RISK_PERCENT: 0, LEVERAGE: 0, MARGIN_TYPE: 'ISOLATED', HEDGE_MODE: true },
      'sub2-68d3f007099f9de77119b413': { API_KEY: 'UcfPb0HxeIjrq7is6JjL0Ta0j3uPlJBxMKYLMvBA4mfNA4xP', API_SECRET: 'piZHMkSkK3w54xZXyCyjwG29WWogmK2Rm0mDrRm7rVyOgLNiKNWAa5C6g9i2JP0H', RISK_PERCENT: 0, LEVERAGE: 0, MARGIN_TYPE: 'ISOLATED', HEDGE_MODE: false },
      'sub3-68d3f007099f9de77119b413': { API_KEY: '08yEHExqOANtGe5L9oz9se1U0p5BW9lBzudlq32GHdrHtsxPUATHmrPvWXww', API_SECRET: 'MJ07NaD6P6DwiOSLWhxfsvLzY5uJ3JxkqcPULjNjtM7VmSuYJIQIfVJNiuOwlGNf', RISK_PERCENT: 0, LEVERAGE: 0, MARGIN_TYPE: 'ISOLATED', HEDGE_MODE: false },
      'sub4-68d3f007099f9de77119b413': { API_KEY: '8OljKOYaO4qiVgPhp3yDSMwjMMOns5SbWGy7n2MnFx7o3MB2LHxlXW', API_SECRET: 'htpG6zPaneQmx7WP1kjlQid9pmuiAFYKgqP3KikARA9wqTC9YDYQe4vFgM7XIWaO', RISK_PERCENT: 0, LEVERAGE: 0, MARGIN_TYPE: 'ISOLATED', HEDGE_MODE: false },
      'sub5-68d3f007099f9de77119b413': { API_KEY: 'pAjcougzAnn06sR1dh933nG6Q5EIGJFE3o2QhnPv0s2y8', API_SECRET: '9dD5FQ8tQJ1qtj9cy8kl4mAMSjAP4PCuNVKh7YPY5glSnRXPTaEnK0VeyugCVKN6', RISK_PERCENT: 0, LEVERAGE: 0, MARGIN_TYPE: 'ISOLATED', HEDGE_MODE: false },
    };
    if (!configs[userId]) throw new Error(`Config not found for ${userId}`);
    return configs[userId];
  }

  public setSocketServer(server: Server) { this.socketServer = server; }

  public activateRestingMode(
    userId: string,
    minutes: 5 | 15 | 30 | 60 | 240 | 720 | 1440 | 2880
  ): { success: boolean; message: string } {
    const state = this.getUserState(userId);
    if (state.restingMode.enabled && Date.now() <= state.restingMode.until) {
      const timeLeft = Math.round((state.restingMode.until - Date.now()) / 60000);
      return { success: false, message: `Resting active, ${timeLeft} min left` };
    }
    const ms = minutes * 60 * 1000;
    state.restingMode = { enabled: true, until: Date.now() + ms, duration: ms };
    return { success: true, message: `Resting for ${minutes}m` };
  }

  public deactivateRestingMode(userId: string): { success: boolean; message: string } {
    const state = this.getUserState(userId);
    if (!state.restingMode.enabled || Date.now() > state.restingMode.until) {
      return { success: false, message: 'Resting mode is already inactive' };
    }
    state.restingMode = { enabled: false, until: 0, duration: 0 };
    return { success: true, message: 'Resting mode off' };
  }

  private isRestingModeActive(userId: string): boolean {
    const state = this.getUserState(userId);
    if (!state.restingMode.enabled) return false;
    if (Date.now() > state.restingMode.until) {
      state.restingMode = { enabled: false, until: 0, duration: 0 };
      console.log(`[${userId}] Resting mode expired automatically`);
      return false;
    }
    return true;
  }

  public activateBurstMode(userId: string): { success: boolean; reason?: string } {
    const state = this.getUserState(userId);
    this.resetDailyCounters(userId);
    if (state.burstUsesToday >= 2) {
      return { success: false, reason: 'Burst used 2 times today' };
    }
    const gapMs = 2* 60 * 60 * 1000;
    if (state.lastBurstActivationTime && (Date.now() - state.lastBurstActivationTime) < gapMs) {
      const timeLeftMin = Math.ceil((gapMs - (Date.now() - state.lastBurstActivationTime)) / 60000);
      return { success: false, reason: `Need ${timeLeftMin} min gap since last burst activation` };
    }
    state.burstModeEnabled = true;
    state.burstEntriesLeft = 2;
    state.lastBurstActivationTime = Date.now();
    state.burstUsesToday++;
    return { success: true };
  }

  public deactivateBurstMode(userId: string): { success: boolean; message?: string } {
    const state = this.getUserState(userId);
    if (!state.burstModeEnabled) {
      return { success: false, message: 'Burst mode is already inactive' };
    }
    state.burstModeEnabled = false;
    state.burstEntriesLeft = 0;
    return { success: true, message: 'Burst mode deactivated' };
  }

  public resetDailyCounters(userId: string) {
    const state = this.getUserState(userId);
    const now = new Date();
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const istTime = new Date(now.getTime() + IST_OFFSET_MS);
    const todayIST = new Date(
      istTime.getUTCFullYear(),
      istTime.getUTCMonth(),
      istTime.getUTCDate()
    );
    if (!state.lastResetDate || state.lastResetDate < todayIST) {
      state.dailyEntryCount = 0;
      state.burstUsesToday = 0;
      state.lastResetDate = todayIST;
      const rest = this.getRestClient(userId);
      rest.getPositionsV3().then(positions => {
        const activeKeys = new Set<string>();
        for (const pos of positions) {
          if (Math.abs(parseFloat(String(pos.positionAmt ?? '0'))) > 0.0001) {
            const key = `${pos.symbol}-${pos.positionSide}`;
            activeKeys.add(key);
          }
        }
        for (const key of state.symbolEntryCounts.keys()) {
          if (!activeKeys.has(key)) {
            state.symbolEntryCounts.delete(key);
          }
        }
      }).catch(() => {});
    }
  }

  private isTradingHours(): boolean {
    const now = new Date();
    const utcHours = now.getUTCHours();
    const utcMinutes = now.getUTCMinutes();
    const utcTotalMinutes = utcHours * 60 + utcMinutes;
    const startTradingUTC = 4 * 60 + 30;
    const endTradingUTC = 14 * 60 + 30;
    return utcTotalMinutes >= startTradingUTC && utcTotalMinutes < endTradingUTC;
  }

  private canPlaceEntry(userId: string): { allowed: boolean; reason?: string } {
    const state = this.getUserState(userId);
    this.resetDailyCounters(userId);
    if (state.dailyEntryCount >= 7) {
      return { allowed: false, reason: 'Max 7 entries/day reached' };
    }
    if (!state.lastEntryTime) {
      return { allowed: true };
    }
    const now = Date.now();
    const elapsed = now - state.lastEntryTime;
    if (state.burstEntriesLeft > 0) {
   //   if (elapsed < 60_000) {
     //   return { allowed: false, reason: 'Wait 1 min in burst' };
      //}
      return { allowed: true };
    }
   // const minGapMs = this.isTradingHours() ? 120 * 60 * 1000 : 60 * 60 * 1000;
   const minGapMs = 0
    if (elapsed < minGapMs) {
      const remainingMinutes = Math.ceil((minGapMs - elapsed) / 60000);
      const remainingSeconds = Math.ceil((minGapMs - elapsed) / 1000);
      if (remainingMinutes > 1) {
        return { allowed: false, reason: `Wait ${remainingMinutes} min` };
      } else {
        return { allowed: false, reason: `Wait ${remainingSeconds} sec` };
      }
    }
    return { allowed: true };
  }

  private async setupTradingMode(userId: string, symbol: string) {
    try {
      const config = this.getUserConfig(userId);
      const restClient = this.getRestClient(userId);
      const levResp = await restClient.setLeverage({ symbol, leverage: config.LEVERAGE });
      if (levResp.leverage !== 15) {
        throw new Error(`Leverage for ${symbol} is ${levResp.leverage}× – must be 15×`);
      }
      try {
        await restClient.setMarginType({
          symbol,
          marginType: config.MARGIN_TYPE as MarginType
        }).catch(() => {});
      } catch {}
      try {
        await restClient.setPositionMode({ dualSidePosition: true } as any).catch(() => {});
      } catch {}
    } catch (err) {
      console.error(`[${userId}] Setup failed:`, err);
      throw err;
    }
  }

  async getUsdtBalance(userId: string): Promise<number> {
    try {
      const restClient = this.getRestClient(userId);
      const balances = await restClient.getBalanceV3();
      const usdt = balances.find((asset: any) => asset.asset === 'USDT');
      if (!usdt) return 0;
      const balance = Number(usdt.availableBalance).toFixed(2);
      return parseFloat(balance);
    } catch {
      return 0;
    }
  }

  private validateOrder(
    type: 'MARKET',
    side: 'BUY' | 'SELL',
    entryPrice: number,
    stopLoss: number,
    takeProfit: number,
    markPrice: number
  ): string | null {
    if (entryPrice <= 0) return 'Invalid entry price';
    if (stopLoss === entryPrice || takeProfit === entryPrice) return 'SL/TP cannot equal entry price';
    if ((side === 'BUY' && stopLoss >= entryPrice) || (side === 'SELL' && stopLoss <= entryPrice)) {
      return `SL must be ${side === 'BUY' ? 'below' : 'above'} entry`;
    }
    if ((side === 'BUY' && takeProfit <= entryPrice) || (side === 'SELL' && takeProfit >= entryPrice)) {
      return `TP must be ${side === 'BUY' ? 'above' : 'below'} entry`;
    }
    if (type === 'MARKET') {
      if (side === 'BUY') {
        if (stopLoss >= markPrice) return 'SL must be < current price for BUY';
        if (takeProfit <= markPrice) return 'TP must be > current price for BUY';
      } else {
        if (stopLoss <= markPrice) return 'SL must be > current price for SELL';
        if (takeProfit >= markPrice) return 'TP must be < current price for SELL';
      }
    }
    return null;
  }

  public async getUsdmSymbols(userId: string): Promise<string[]> {
    try {
      const restClient = this.getRestClient(userId);
      const info = await restClient.getExchangeInfo();
      const usdmSymbols = info.symbols
        .filter((s: any) =>
          s.contractType === 'PERPETUAL' &&
          s.status === 'TRADING' &&
          s.quoteAsset === 'USDT'
        )
        .map((s: any) => s.symbol)
        .sort();
      return usdmSymbols;
    } catch (err: any) {
      return ['BTCUSDT', 'ETHUSDT'];
    }
  }

  private canEnterSymbolSide(userId: string, symbol: string, positionSide: 'LONG' | 'SHORT'): { allowed: boolean; reason?: string } {
    const state = this.getUserState(userId);
    const key = `${symbol}-${positionSide}`;
    const count = state.symbolEntryCounts.get(key) || 0;
    if (count >= 2) {
      return { allowed: false, reason: `Max 2 entries/day for ${symbol} ${positionSide}` };
    }
    return { allowed: true };
  }

  public async orderPreflight(params: {
    userId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    stopLoss: number;
    takeProfit: number;
    riskPercent?: number;
  }): Promise<any> {
    const { userId, symbol, side, stopLoss, takeProfit, riskPercent } = params;
    await this.setupTradingMode(userId, symbol);
    const restClient = this.getRestClient(userId);
    const markPrices = await restClient.getMarkPrice();
    const markPriceObj = markPrices.find((p: any) => p.symbol === symbol);
    if (!markPriceObj) throw new Error('Mark price not found');
    const markPrice = Number(markPriceObj.markPrice);
    const balance = await this.getUsdtBalance(userId);
   
    const riskAmount = ((riskPercent??0.4) / 100) * balance;
    const priceDiff = Math.abs(markPrice - stopLoss);
    if (priceDiff <= 0) throw new Error('Invalid SL distance');
    const rawQty = riskAmount / priceDiff;
    let quantity = rawQty < 1 ? rawQty.toFixed(3) : Math.round(rawQty).toString();
    const notionalEntry = parseFloat(quantity) * markPrice;
    const notionalSL = parseFloat(quantity) * stopLoss;
    const notionalTP = parseFloat(quantity) * takeProfit;
    if (notionalEntry < 5 || notionalSL < 5 || notionalTP < 5) {
      throw new Error(`Notional <5 USDT`);
    }
    const maxLossUSDT = parseFloat(quantity) * Math.abs(markPrice - stopLoss);
    const maxProfitUSDT = parseFloat(quantity) * Math.abs(takeProfit - markPrice);
    const riskRewardRatio = (maxProfitUSDT / maxLossUSDT).toFixed(2);
    return {
      symbol,
      side,
      quantity,
      markPrice,
      stopLoss,
      takeProfit,
      riskPercent: riskPercent || (riskAmount / balance) * 100,
      maxLossUSDT,
      maxProfitUSDT,
      riskRewardRatio,
    };
  }

  async placeFullOrder(params: {
    userId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'MARKET';
    stopPrice?: number;
    stopLoss: number;
    takeProfit: number;
    newClientOrderId?: string;
    closePosition?: 'true' | 'false';
    isScalping?: boolean;
    riskPercent?: number;
      isAlgoEntry?: boolean;
  }) {
    const { userId, symbol, side, type, stopPrice, stopLoss, takeProfit,riskPercent,isScalping = false,isAlgoEntry = false } = params;
    const precision = await this.getSymbolPrecision(symbol);
    const ALLOWED_ACCOUNT_ID = "68d3f007099f9de77119b413";
    if (userId !== ALLOWED_ACCOUNT_ID) {
      console.log(`ENTRY BLOCKED → Unauthorized user: ${userId}`);
      throw new Error("Trading is restricted to main account only");
    }
    const openPositions = await this.getOpenPositions(userId);
    console.log(`[${userId}] Current open positions: ${openPositions.length}`);
  if (openPositions.length >= 10) {
    throw new Error('ENTRY BLOCKED: Maximum 10 open positions allowed globally');
  }
    const rootClientId = uuidv4().replace(/-/g, '').substring(0, 14);
    const entryClientId = `${this.OUR_CLIENT_PREFIX}_en-${rootClientId}`;
    const slClientId = `${this.OUR_CLIENT_PREFIX}_sl-${rootClientId}`;
    const tpClientId =`${this.OUR_CLIENT_PREFIX}_tp-${rootClientId}`;
    const state = this.getUserState(userId);
    if (!['MARKET'].includes(type)) {
      throw new Error('Only MARKET allowed');
    }

    const targetPositionSide = side === 'BUY' ? 'LONG' : 'SHORT';
 const openOrders = await this.getPendingOrders(userId, symbol);
    const slTpCount = openOrders.filter(o =>
      o.positionSide === targetPositionSide &&
      ['STOP_MARKET', 'TAKE_PROFIT_MARKET'].includes(o.algoType)
    ).length;
    if (slTpCount >= 8) {
      throw new Error(`ENTRY BLOCKED: Max 8 SL/TP per symbol on ${targetPositionSide} side (current: ${slTpCount})`);
    }

     const symbolLimit = this.canEnterSymbolSide(userId, symbol, targetPositionSide);
    if (!symbolLimit.allowed) {
      throw new Error(`ENTRY BLOCKED: ${symbolLimit.reason}`);
    }

    /*
       if (!isAlgoEntry) {
    if (this.isRestingModeActive(userId)) {
      throw new Error('ENTRY BLOCKED: Resting mode active');
    }
    const canEnter = this.canPlaceEntry(userId);
    if (!canEnter.allowed) {
      throw new Error(`ENTRY BLOCKED: ${canEnter.reason}`);
    }
  }
    */
    await this.setupTradingMode(userId, symbol);
    const balance = await this.getUsdtBalance(userId);
 //const balance = 100
    if (balance <= 0) throw new Error('No USDT available');
    const restClient = this.getRestClient(userId);
    const markPrices = await restClient.getMarkPrice();
    const markPriceObj = markPrices.find((p: any) => p.symbol === symbol);
    if (!markPriceObj) throw new Error('Mark price not found');
    const markPrice = Number(markPriceObj.markPrice);
    const entryPrice = type === 'MARKET' ? markPrice : (stopPrice || 0);
    if (entryPrice <= 0) throw new Error('Invalid entry price');
    const validationError = this.validateOrder(type, side, entryPrice, stopLoss, takeProfit, markPrice);
    if (validationError) { throw new Error(`Order rejected: ${validationError}`); }
    const priceDiff = Math.abs(entryPrice - stopLoss);
    const riskAmount = ((riskPercent??0.4)/ 100) * balance;
    const rawQty = riskAmount / priceDiff;
    let quantity = rawQty < 1 ? rawQty.toFixed(precision.qtyPrecision) : Math.round(rawQty).toString();
    const notionalEntry = parseFloat(quantity) * markPrice;
    const notionalSL = parseFloat(quantity) * stopLoss;
    const notionalTP = parseFloat(quantity) * takeProfit;
    if (notionalEntry < 5 || notionalSL < 5 || notionalTP < 5) {
      throw new Error(`Notional <5: Entry=${entryPrice}, SL=${stopLoss}, TP=${takeProfit}`);
    }
    console.log(`[${userId}] Placing entry: ${symbol} ${side} Qty:${quantity} Entry:${entryPrice} SL:${stopLoss} TP:${takeProfit} RR:${(notionalTP/notionalSL).toFixed(2)}`);
    const entryOrder = await this.placeOrder(userId, {
      symbol,
      side,
      type,
      quantity,
      newClientOrderId: entryClientId,
      positionSide: side === 'BUY' ? 'LONG' : 'SHORT',
      closePosition: 'false'
    });
    state.dailyEntryCount++;
    state.lastEntryTime = Date.now();
    if (state.burstEntriesLeft > 0) {
      state.burstEntriesLeft--;
      if (state.burstEntriesLeft === 0) {
        state.burstModeEnabled = false;
      }
    }
    let filledQty = quantity;
    const finalQty = this.round(parseFloat(filledQty), precision.qtyPrecision).toString();
    const orderId = 'orderId' in entryOrder ? entryOrder.orderId : entryOrder.algoId;
    for (let i = 0; i < 30; i++) {
      try {
        const order = await restClient.getOrder({ symbol, orderId });
        if (order.status === 'FILLED') {
          filledQty = order.executedQty.toString();
          break;
        }
        if (['CANCELED', 'EXPIRED'].includes(order.status)) {
          throw new Error('Entry failed');
        }
      } catch (_) { }
      await new Promise(r => setTimeout(r, 700));
    }
    let slOk = true;
    try {
      await this.placeOrder(userId, {
        symbol,
        side: side === 'BUY' ? 'SELL' : 'BUY',
        type: 'STOP_MARKET',
        triggerPrice: this.round(stopLoss, precision.pricePrecision),
        quantity: finalQty,
        timeInForce: 'GTE_GTC',
        workingType: 'MARK_PRICE',
        priceProtect: 'TRUE',
        closePosition: 'false',
        positionSide: side === 'BUY' ? 'LONG' : 'SHORT',
        newClientOrderId: slClientId
      });
    } catch (e) {
      slOk = false;
    }
    let tpOk = true;
    try {
      await this.placeOrder(userId, {
        symbol,
        side: side === 'BUY' ? 'SELL' : 'BUY',
        type: 'TAKE_PROFIT_MARKET',
        triggerPrice: this.round(takeProfit, precision.pricePrecision),
        quantity: finalQty,
        timeInForce: 'GTE_GTC',
        workingType: 'MARK_PRICE',
        priceProtect: 'TRUE',
        closePosition: 'false',
        positionSide: side === 'BUY' ? 'LONG' : 'SHORT',
        newClientOrderId: tpClientId
      });
    } catch (e) {
      tpOk = false;
    }
    if (slOk && tpOk) {
      const symbolSideKey = `${symbol}-${targetPositionSide}`;
      const currentCount = (state.symbolEntryCounts.get(symbolSideKey) || 0) + 1;
      state.symbolEntryCounts.set(symbolSideKey, currentCount);
      const PositionSide = side === 'BUY' ? 'LONG' : 'SHORT';
      const key = `${userId}-${symbol}-${PositionSide}-${side}-${slClientId}-${tpClientId}`;
      const firstTriggerMul = isScalping ? 1.02 : 1.03;
      const firstMoveMul = isScalping ? 1.005 : 1.008;
      const BigTriggerMul = isScalping ? 1.25 : 1.34;
      const BigMoveMul = isScalping ? 1.18 : 1.25;
      this.trailingState.set(key, {
        side,
        symbol,
        positionSide: PositionSide as any,
        currentSL: this.round(stopLoss, precision.pricePrecision),
        currentTP: this.round(takeProfit, precision.pricePrecision),
        qty: finalQty,
        trailCount: 0,
        isScalping,
        nextTriggerPrice: this.round(side === 'BUY' ? stopLoss * firstTriggerMul : stopLoss / firstTriggerMul, precision.pricePrecision),
        nextSL: this.round(side === 'BUY' ? stopLoss * firstMoveMul : stopLoss / firstMoveMul, precision.pricePrecision),
        nextTP: this.round(side === 'BUY' ? takeProfit * firstMoveMul : takeProfit / firstMoveMul, precision.pricePrecision),
        bigMoveTriggerPrice: this.round(side === 'BUY' ? stopLoss * BigTriggerMul : stopLoss / BigTriggerMul, precision.pricePrecision),
        bigMoveNextSL: this.round(side === 'BUY' ? stopLoss * BigMoveMul: stopLoss / BigMoveMul, precision.pricePrecision),
        bigMoveNextTP: this.round(side === 'BUY' ? takeProfit * BigMoveMul: takeProfit / BigMoveMul, precision.pricePrecision),
        slClientId,
        tpClientId
      });
      console.log(`[${userId}] TRAILING STARTED → ${symbol} ${targetPositionSide} | SL:${stopLoss} TP:${takeProfit}`,this.trailingState);
    }
    if (!slOk || !tpOk) {
      const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
      try {
        await this.placeOrder(userId, {
          symbol,
          side: closeSide,
          type: 'MARKET',
          quantity: filledQty,
          positionSide: side === 'BUY' ? 'LONG' : 'SHORT'
        });
      } catch (closeErr) {
      }
      throw new Error('SL/TP placement failed – position closed');
    }
    return { clientId: rootClientId, quantity: filledQty, entryPrice, balance };
  }

  async getTradeHistory(userId: string, params: { symbol: string; startTime?: number; endTime?: number; limit?: number; }) {
    const restClient = this.getRestClient(userId);
    return restClient.getAccountTrades(params);
  }

  async getOpenPositions(userId: string): Promise<any[]> {
    const restClient = this.getRestClient(userId);
    try {
      const data = await restClient.getPositions();
      const filteredPositions = Array.isArray(data)
        ? data.filter((position: any) => {
            const amt = position.positionAmt?.toString() || '0';
            const floatAmt = parseFloat(amt);
            return floatAmt !== 0 && !isNaN(floatAmt);
          })
        : [];
      return filteredPositions;
    } catch {
      return [];
    }
  }

  async getPendingOrders(userId: string, symbol?: string) {
    const restClient = this.getRestClient(userId);
    return restClient.getOpenAlgoOrders(symbol ? { symbol } : undefined);
  }

  async getAllOrders(userId: string, symbol?: string) {
    const restClient = this.getRestClient(userId);
    return restClient.getAllOrders({ symbol: symbol || '', limit: 10 });
  }

  async closePosition(params: {
    userId: string;
    symbol: string;
    positionAmt: string;
    mside: 'BUY' | 'SELL';
    positionSide: 'LONG' | 'SHORT';
    updateTime: number;
  }): Promise<{ success: boolean; message: string }> {
    const { userId, symbol, positionAmt, mside, positionSide, updateTime } = params;
    const now = moment().utc();
    const lastUpdate = moment(new Date(updateTime));
    const minutesDifference = now.diff(lastUpdate, 'minutes');
    if (minutesDifference < 240) {
      return {
        success: false,
        message: `Position can be closed after ${240 - minutesDifference} minutes.`
      };
    }
    try {
      const rootClientId = uuidv4().replace(/-/g, '').substring(0, 14);
      const cpClientId =`${this.OUR_CLIENT_PREFIX}_cp-${rootClientId}`;
      const close = await this.placeOrder(userId, {
        symbol,
        side: mside,
        type: 'MARKET',
        closePosition: 'true',
        quantity: Math.abs(parseFloat(positionAmt)),
        positionSide: positionSide,
        newClientOrderId:cpClientId
      });
      return {
        success: true,
        message: `${symbol} Position Closed Successfully`
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Failed: ${error.message}`
      };
    }
  }

  async modifyOrder(params: {
    userId: string;
    symbol: string;
    orderId: string;
    positionAmt: string;
    side: 'BUY' | 'SELL';
    positionSide: 'LONG' | 'SHORT';
    oldPrice: number;
    lastupdate: number;
    newPrice: number;
    type: 'SL' | 'TP';
    clientId?: string;
  }): Promise<{ success: boolean; message: string }> {
    const {
      userId, symbol, orderId, positionAmt, side, positionSide,
      oldPrice, lastupdate, newPrice, type, clientId } = params;
    console.log("modify order params",params)
    const RelaceClientId =clientId
      ? clientId.slice(0, -5) + clientId.slice(-5).split('').reverse().join('')
      : clientId;
    if (!newPrice || newPrice <= 0) {
      const msg = `Invalid ${type} price: ${newPrice}`;
      return { success: false, message: msg };
    }
    const now = moment().utc();
    const lastexecute = moment(lastupdate);
    const TimeDone = now.diff(lastexecute, 'minutes');
    const minWait = type === 'SL' ? 240: 240;
    if (TimeDone < minWait) {
      const waitLeft = minWait - TimeDone;
      const msg = `Wait ${waitLeft} min to modify ${type} (only ${TimeDone} min passed)`;
      console.log(`[${userId}] Modify ${type} BLOCKED → ${msg}`);
      return { success: false, message: msg };
    }
    let marketPrice: number;
    try {
      const restClient = this.getRestClient(userId);
      const markPrices = await restClient.getMarkPrice();
      const priceObj = markPrices.find((p: any) => p.symbol === symbol);
      if (!priceObj?.markPrice) throw new Error('Mark price not found');
      marketPrice = Number(priceObj.markPrice);
    } catch (err: any) {
      const msg = `Market price fetch failed: ${err.message || 'Unknown'}`;
      return { success: false, message: msg };
    }
    if (type === 'SL') {
      if (side === 'BUY' && newPrice >= oldPrice) {
        const msg = `Cannot increase loss: New SL (${newPrice}) >= Old SL (${oldPrice})`;
        return { success: false, message: msg };
      }
      if (side === 'SELL' && newPrice <= oldPrice) {
        const msg = `Cannot increase loss: New SL (${newPrice}) <= Old SL (${oldPrice})`;
        return { success: false, message: msg };
      }
    }
    let valid = false;
    let reason = '';
    if (type === 'SL') {
      if (side === 'SELL' && newPrice < marketPrice) valid = true;
      else if (side === 'BUY' && newPrice > marketPrice) valid = true;
      else reason = `SL must be ${side === 'SELL' ? 'below' : 'above'} market (${marketPrice.toFixed(5)})`;
    }
    if (type === 'TP') {
      if (side === 'SELL' && newPrice > marketPrice) valid = true;
      else if (side === 'BUY' && newPrice < marketPrice) valid = true;
      else reason = `TP must be ${side === 'SELL' ? 'above' : 'below'} market (${marketPrice.toFixed(5)})`;
    }
    if (!valid) {
      return { success: false, message: reason };
    }
    const newOrderType = type === 'SL' ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET';
    try {
      const restClient = this.getRestClient(userId);
      console.log('Modify order params:',symbol, side, newOrderType, newPrice, positionAmt, positionSide, RelaceClientId );
      const modifyResult = await this.placeOrder(userId, {
        symbol,
        side,
        type: newOrderType,
        triggerPrice: newPrice,
        quantity: positionAmt,
        timeInForce: 'GTE_GTC',
        workingType: 'MARK_PRICE',
        priceProtect: 'TRUE',
        positionSide,
        newClientOrderId:RelaceClientId
      });
      if (
        modifyResult.timeInForce==='GTE_GTC'){
        try {
          await restClient.cancelAlgoOrder({
            clientAlgoId:params.clientId
          });
          const getBaseId = (id: string): string => {
            const match = id.match(/_(?:sl|tp)-([a-z0-9]{7})/i);
            return match ? match[1] : '';
          };
          const baseId = getBaseId(clientId || '');
          for (const [key, state] of this.trailingState.entries()) {
            if (
              state.symbol === symbol &&
              state.positionSide === positionSide &&
              getBaseId(state.slClientId) === baseId
            ) {
              const precision = await this.getSymbolPrecision(symbol);
              const isLong = state.side === 'BUY';
              state.currentSL = type === 'SL' ? newPrice : state.currentSL;
              state.currentTP = type === 'TP' ? newPrice : state.currentTP;
              if (RelaceClientId) {
                if (type === 'SL') state.slClientId = RelaceClientId;
                if (type === 'TP') state.tpClientId = RelaceClientId;
              }
              state.trailCount = 1;
              const isScalping = state.isScalping;
              const triggerMul = isScalping ? 1.02 : 1.10;
              const moveMul = isScalping ? 1.01 : 1.04;
              state.nextTriggerPrice = this.round(isLong ? state.currentSL * triggerMul : state.currentSL / triggerMul, precision.pricePrecision);
              state.nextSL = this.round(isLong ? state.currentSL * moveMul : state.currentSL / moveMul, precision.pricePrecision);
              state.nextTP = this.round(isLong ? state.currentTP * moveMul : state.currentTP / moveMul, precision.pricePrecision);
              const bigTriggerMul = isScalping ? 1.030 : 1.34;
              const bigMoveMul = isScalping ? 1.025 : 1.29;
              state.bigMoveTriggerPrice = this.round(isLong ? state.currentSL * bigTriggerMul : state.currentSL / bigTriggerMul, precision.pricePrecision);
              state.bigMoveNextSL = this.round(isLong ? state.currentSL * bigMoveMul : state.currentSL / bigMoveMul, precision.pricePrecision);
              state.bigMoveNextTP = this.round(isLong ? state.currentTP * bigMoveMul : state.currentTP / bigMoveMul, precision.pricePrecision);
              break;
            }
          }
        } catch (cancelErr: any) { }
      } else{
        throw new Error('Modify order placement failed');
      }
      return { success: true, message: `${type} updated to ${newPrice.toFixed(5)}` };
    } catch (error: any) {
      const errMsg = error?.message || error?.toString() || 'Unknown error';
      console.error(`[${userId}] MODIFY ${type} FAILED → ${errMsg}`);
      return { success: false, message: `Modify failed: ${errMsg}` };
    }
  }

  async enableHedgeMode(userId: string) {
    const restClient = this.getRestClient(userId);
    return restClient.setPositionMode({ dualSidePosition: 'true' } as any);
  }

  async setLeverage(userId: string, symbol: string, leverage: number) {
    const restClient = this.getRestClient(userId);
    return restClient.setLeverage({ symbol, leverage });
  }

  async retrieveRateLimit(userId: string) {
    const restClient = this.getRestClient(userId);
    try {
    } catch (error) {
    }
  }

  public async addManualMargin(params: {
    userId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    amount: number;
  }): Promise<{ success: boolean; message: string }> {
    const { userId, symbol, side, amount } = params;
    if (!symbol || !side || amount <= 0) {
      return { success: false, message: 'Invalid: symbol, side, amount > 0 required' };
    }
    try {
      const restClient = this.getRestClient(userId);
      const positionSide = side === 'BUY' ? 'LONG' : 'SHORT';
      await restClient.setIsolatedPositionMargin({
        symbol,
        positionSide,
        amount,
        type: "1"
      });
      return { success: true, message: `+${amount} USDT added` };
    } catch (err: any) {
      return { success: false, message: `Failed: ${err.message}` };
    }
  }

  public getBotStatus(userId: string) {
    this.retrieveRateLimit(userId);
    const state = this.getUserState(userId);
    const now = Date.now();
    if (state.restingMode.enabled && now > state.restingMode.until) {
      state.restingMode = { enabled: false, until: 0, duration: 0 };
      console.log(`[${userId}] Resting mode expired in status check`);
    }
    this.resetDailyCounters(userId);
    const requiredGapMinutes = this.isTradingHours() ? 120 : 60;
    const lastEntryGap = state.lastEntryTime ? (now - state.lastEntryTime) / 60000 : null;
    const timeUntilNext = state.lastEntryTime
      ? Math.max(0, requiredGapMinutes * 60 * 1000 - (now - state.lastEntryTime)) / 60000
      : 0;
    const restingTimeLeft = state.restingMode.enabled
      ? Math.max(0, (state.restingMode.until - now) / 60000)
      : 0;
    return {
      userId,
      dailyEntries: state.dailyEntryCount,
      maxDailyEntries: 10,
      burstEnabled: state.burstModeEnabled,
      burstEntriesLeft: state.burstEntriesLeft,
      burstUsesToday: state.burstUsesToday,
      maxBurstUses: 3,
      lastEntryMinutesAgo: lastEntryGap ? Math.floor(lastEntryGap) : null,
      requiredGapMinutes: requiredGapMinutes,
      timeUntilNextEntryUntil: state.lastEntryTime
        ? state.lastEntryTime + requiredGapMinutes * 60 * 1000
        : 0,
      restingEnabled: state.restingMode.enabled,
      restingMinutesLeft: Math.round(restingTimeLeft),
      restingUntil: state.restingMode.until,
      isTradingHours: this.isTradingHours(),
      maxSlTpPerSymbol: 8,
    };
  }
}

