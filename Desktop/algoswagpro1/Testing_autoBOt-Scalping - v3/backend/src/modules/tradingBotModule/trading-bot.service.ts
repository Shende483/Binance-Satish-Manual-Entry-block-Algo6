

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { WebsocketClient, USDMClient } from 'binance';
import { Server, DefaultEventsMap } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { User } from '../authModule/user.schema';
import { TradeX } from './trade.schema';

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
  private candles5m: Record<string, any[]> = {};
  private candles15m: Record<string, any[]> = {};
  private current5mAggregators: Record<string, any> = {};
  private current15mAggregators: Record<string, any> = {};

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
    patternType: 'HAMMER' | 'INVERSE_HAMMER' | 'BULLISH_ENGULFING' | 'BEARISH_ENGULFING' | 'BULLISH_HARAMI' | 'BEARISH_HARAMI' | 'BULLISH_SPINNING_TOP' | 'BEARISH_SPINNING_TOP' | 'BULLISH_INSIDE_BAR' | 'BEARISH_INSIDE_BAR';
    historyCheckCandles?: number;
    volumeTimeframe?: string;
    patternEntryTimeframe: '1m' | '5m' | '15m';
  }>();

  private virtualOrders = new Map<string, {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    triggerPrice: number;
    quantity: number;
    positionSide: 'LONG' | 'SHORT';
    workingType: 'MARK_PRICE';
    clientAlgoId: string;
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
    @InjectModel(TradeX.name) private tradeModel: Model<TradeX>,
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

  private async hasHigherTFConfirmation(symbol: string, side: 'BUY' | 'SELL'): Promise<boolean> {
  console.log("hhhhhhhhhhhhhhhhhhhh", symbol, side);
    const isBullish = side === 'BUY';
    const tfs = ['30m', '1h', '2h', '4h', '1d'];
    for (const tf of tfs) {
      if (await this.hasSamePatternInHigherTF(symbol, tf, isBullish)) return true;
    }
    return false;
  }

  private async hasSamePatternInHigherTF(symbol: string, interval: string, wantBullish: boolean): Promise<boolean> {
    try {
      const klines = await this.publicRest.getKlines({ symbol, interval: interval as any, limit: 16 });
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
        let patternName = '';
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
          patternName = 'Hammer';
          patternLow = c2.low;
          firstCandleLow = c1.low;
          
        }

        if (!wantBullish && this.isInverseHammer(c1) &&
            c2.high !== c2.open && c2.close < c1.low &&
            c3.low < c2.low && c3.high < c2.high && c2.high < c1.high &&
              currentPrice < c2.high && currentPrice > c3.low
          
          ) {
          patternFound = true;
          patternName = 'Inverse Hammer';
          patternHigh = c2.high;
          firstCandleHigh = c1.high;
        }

        if (wantBullish && this.isBullishSpinningTop(c1) &&
            c2.low !== c2.open && c2.close > c1.high &&
            c3.high > c2.high && c3.low > c2.low && c2.low > c1.low &&
              currentPrice > c2.low && currentPrice < c3.high
          
          ) {
          patternFound = true;
          patternName = 'bullish spinning top ';
          patternLow = c2.low;
          firstCandleLow = c1.low;
        }

        if (!wantBullish && this.isBearishSpinningTop(c1) &&
            c2.high !== c2.open && c2.close < c1.low &&
            c3.low < c2.low && c3.high < c2.high && c2.high < c1.high &&
           currentPrice < c2.high && currentPrice > c3.low
          ) {
          patternFound = true;
          patternName = 'bearish spinning top ';
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
          patternName = 'bullish engulfing ';
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
          patternName = 'bearish engulfing ';
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
          patternName = 'bullish harami ';
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
          patternName = 'bearish harami';
          patternHigh = c3.high;
          firstCandleHigh = c1.high;
        }


       
if (patternFound) {
  console.log(`Pattern ${patternName} detected on ${symbol} at ${new Date(candles[i - 3].startTime).toISOString()} in ${interval}`);
  const historyStart = i - 3 - 3;
 // const historyStart = i - 3 - 5;
  if (historyStart < 0) {
    console.log(`History fail: Not enough candles (need 5 before pattern)`);
    continue;
  }

  const historyCandles = candles.slice(historyStart, i - 3);
  console.log(`History candles count: ${historyCandles.length}, from index ${historyStart} to ${i-3}`);

  if (wantBullish) {
    const minLow = Math.min(...historyCandles.map(c => c.low));
    console.log(`Bullish - minLow in history: ${minLow}, patternLow: ${firstCandleLow}`);
    if (minLow <= firstCandleLow) {
      console.log(`History fail: lower low found (${minLow} <= ${firstCandleLow})`);
      continue;
    }
  } else {
    const maxHigh = Math.max(...historyCandles.map(c => c.high));
    console.log(`Bearish - maxHigh in history: ${maxHigh}, patternHigh: ${firstCandleHigh}`);
    if (maxHigh >= firstCandleHigh) {
      console.log(`History fail: higher high found (${maxHigh} >= ${firstCandleHigh})`);
      continue;
    }
  }

  const postStart = i + 1;
  if (postStart < candles.length) {
    const postCandles = candles.slice(postStart);
    console.log(`Post candles count: ${postCandles.length}, from index ${postStart}`);

    if (wantBullish) {
      const minPostLow = Math.min(...postCandles.map(c => c.low));
      console.log(`Bullish - minPostLow: ${minPostLow}, patternLow: ${patternLow}`);
      if (minPostLow < patternLow) {
        console.log(`Post fail: lower low in post candles (${minPostLow} < ${patternLow})`);
        continue;
      }
    } else {
      const maxPostHigh = Math.max(...postCandles.map(c => c.high));
      console.log(`Bearish - maxPostHigh: ${maxPostHigh}, patternHigh: ${patternHigh}`);
      if (maxPostHigh > patternHigh) {
        console.log(`Post fail: higher high in post candles (${maxPostHigh} > ${patternHigh})`);
        continue;
      }
    }
  }

  console.log(`All checks passed → returning true for ${patternName}`);
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
             // mother.close < mother.open &&
              breakout.close > mother.high &&
              breakout.low > mother.low &&
              breakout.close > breakout.open && 
              breakout.open !== breakout.low &&
              confirm.high > breakout.high && 
              confirm.low > breakout.low &&
              currentPrice > breakout.low &&
              currentPrice < confirm.high
            ) {
            patternFound = true;
            patternName = 'bullish inside bar';
            patternLow = breakout.low;
            firstCandleLow = mother.low;
          }
          if (!wantBullish &&
             // mother.close > mother.open &&
              breakout.close < mother.low &&
              breakout.high < mother.high &&
              breakout.close < breakout.open && 
              breakout.open !== breakout.high &&
              confirm.low < breakout.low &&
              confirm.high < breakout.high &&
              currentPrice < breakout.high &&
              currentPrice > confirm.low
            ) {
            patternFound = true;
            patternName = 'bearish inside bar';
            patternHigh = breakout.high;
            firstCandleHigh = mother.high;
          }

if (patternFound) {
  console.log(`Pattern ${patternName} detected on ${symbol} at ${new Date(mother.startTime).toISOString()} in ${interval}`);
  const historyStart = motherIndex - 3;
//  const historyStart = motherIndex - 5;
  if (historyStart < 0) {
    console.log(`Inside Bar History fail: Not enough candles (need 5 before mother)`);
    continue;
  }

  const historyCandles = candles.slice(historyStart, motherIndex);
  console.log(`Inside Bar History candles count: ${historyCandles.length}, from ${historyStart} to ${motherIndex-1}`);

  if (wantBullish) {
    const minLow = Math.min(...historyCandles.map(c => c.low));
    console.log(`Bullish Inside - minLow: ${minLow}, patternLow: ${firstCandleLow}`);
    if (minLow <= firstCandleLow) {
      console.log(`Inside Bar History fail: lower low found (${minLow} <= ${firstCandleLow})`);
      continue;
    }
  } else {
    const maxHigh = Math.max(...historyCandles.map(c => c.high));
    console.log(`Bearish Inside - maxHigh: ${maxHigh}, patternHigh: ${firstCandleHigh}`);
    if (maxHigh >= firstCandleHigh) {
      console.log(`Inside Bar History fail: higher high found (${maxHigh} >= ${firstCandleHigh})`);
      continue;
    }
  }

  const postStart = i + 1;
  if (postStart < candles.length) {
    const postCandles = candles.slice(postStart);
    console.log(`Inside Bar Post candles count: ${postCandles.length}, from ${postStart}`);

    if (wantBullish) {
      const minPostLow = Math.min(...postCandles.map(c => c.low));
      console.log(`Bullish Inside - minPostLow: ${minPostLow}, patternLow: ${patternLow}`);
      if (minPostLow < patternLow) {
        console.log(`Inside Bar Post fail: lower low in post (${minPostLow} < ${patternLow})`);
        continue;
      }
    } else {
      const maxPostHigh = Math.max(...postCandles.map(c => c.high));
      console.log(`Bearish Inside - maxPostHigh: ${maxPostHigh}, patternHigh: ${patternHigh}`);
      if (maxPostHigh > patternHigh) {
        console.log(`Inside Bar Post fail: higher high in post (${maxPostHigh} > ${patternHigh})`);
        continue;
      }
    }
  }

  console.log(`Inside Bar all checks passed → return true`);
  return true;
}



        }
      }
      return false;
    } catch {
      return false;
    }
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
    const intervalMs = intervalMin * 60 * 1000;
    const expectedEnd = currentAgg[symbol].startTime + intervalMs - 1;
    if (oneMinCandle.endTime >= expectedEnd) {
      const completed = { ...currentAgg[symbol], endTime: expectedEnd, isFinal: true };
      if (!candlesArray[symbol]) candlesArray[symbol] = [];
      candlesArray[symbol].push(completed);
      if (candlesArray[symbol].length > 100) candlesArray[symbol].shift();
      delete currentAgg[symbol];
      this.checkForPatterns(symbol, `${intervalMin}m`);
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
        this.checkForPatterns(update.symbol, '1m');
      }
    }
    if (candle.isFinal) {
      this.aggregateCandle(update.symbol, candle, 5, this.current5mAggregators, this.candles5m);
      this.aggregateCandle(update.symbol, candle, 15, this.current15mAggregators, this.candles15m);
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
          volumeTimeframe: pos.volumeTimeframe,
          patternEntryTimeframe: pos.patternEntryTimeframe
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

  private async checkForPatterns(symbol: string, interval: string) {
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

      // Hammer pattern
      if (this.isHammer(candle1)) {
        if ((candle1.high - candle1.low) / candle1.low > maxPercent) return;
        if ((candle2.high - candle2.low) / candle2.low > maxPercent) return;
        if ((candle3.high - candle3.low) / candle3.low > maxPercent) return;
        if (candle2.low != candle2.open && candle2.close > candle1.high && candle3.high > candle2.high && candle3.low > candle2.low && candle2.low > candle1.low) {
          try {
            console.log(`Hammer detected on ${symbol} at ${new Date(candle1.startTime).toISOString()}`);
            const historical = await this.publicRest.getKlines({
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
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const baseWindows = [
             // 1440, 720, 240, 180, 120, 60, 15,
              15];
            const checkWindows = baseWindows.map(w => Math.ceil(w / intervalMin));
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const minLow = Math.min(...checkPrev.map((c: any) => c.low));
              if (minLow > candle1.low) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (
                 // volumeTf 
                // && 
                 await this.hasHigherTFConfirmation(symbol, 'BUY')
                ) {
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
                      historyCheckCandles: numCandles,
                      volumeTimeframe: '4h',
                    interval: interval as '1m' | '5m' | '15m'
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

      // Inverse Hammer pattern
      if (this.isInverseHammer(candle1)) {
        if ((candle1.high - candle1.low) / candle1.low > maxPercent) return;
        if ((candle2.high - candle2.low) / candle2.low > maxPercent) return;
        if ((candle3.high - candle3.low) / candle3.low > maxPercent) return;
        if (candle2.high != candle2.open && candle2.close < candle1.low && candle3.low < candle2.low && candle3.high < candle2.high && candle2.high < candle1.high) {
          try {
            console.log(`Inverse Hammer detected on ${symbol} at ${new Date(candle1.startTime).toISOString()}`);
            const historical = await this.publicRest.getKlines({
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
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const baseWindows = [
              //1440, 720, 240, 180, 120, 60, 15,
              15];
            const checkWindows = baseWindows.map(w => Math.ceil(w / intervalMin));
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const maxHigh = Math.max(...checkPrev.map((c: any) => c.high));
              if (maxHigh < candle1.high) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (
                 // volumeTf
                  //&&
                   await this.hasHigherTFConfirmation(symbol, 'SELL')
                ) {
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
                      historyCheckCandles: numCandles,
                      volumeTimeframe: '4h',
                     interval: interval as '1m' | '5m' | '15m'
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

      // Bullish Spinning Top pattern
      if (this.isBullishSpinningTop(candle1)) {
        if ((candle1.high - candle1.low) / candle1.low > maxPercent) return;
        if ((candle2.high - candle2.low) / candle2.low > maxPercent) return;
        if ((candle3.high - candle3.low) / candle3.low > maxPercent) return;
        if (candle2.low != candle2.open && candle2.close > candle1.high && candle3.high > candle2.high && candle3.low > candle2.low && candle2.low > candle1.low) {
          try {
            const historical = await this.publicRest.getKlines({
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
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const baseWindows = [
            //  1440, 720, 240, 180, 120, 60, 15,
              15];
            const checkWindows = baseWindows.map(w => Math.ceil(w / intervalMin));
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const minLow = Math.min(...checkPrev.map((c: any) => c.low));
              if (minLow > candle1.low) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (
                //  volumeTf
                  // &&
                    await this.hasHigherTFConfirmation(symbol, 'BUY')
                  ) {
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
                      historyCheckCandles: numCandles,
                      volumeTimeframe: '4h',
                      interval: interval as '1m' | '5m' | '15m'
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

      // Bearish Spinning Top pattern
      if (this.isBearishSpinningTop(candle1)) {
        if ((candle1.high - candle1.low) / candle1.low > maxPercent) return;
        if ((candle2.high - candle2.low) / candle2.low > maxPercent) return;
        if ((candle3.high - candle3.low) / candle3.low > maxPercent) return;
        if (candle2.high != candle2.open && candle2.close < candle1.low && candle3.low < candle2.low && candle3.high < candle2.high && candle2.high < candle1.high) {
          try {
            const historical = await this.publicRest.getKlines({
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
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const baseWindows = [
             // 1440, 720, 240, 180, 120, 60, 15,
              15];
            const checkWindows = baseWindows.map(w => Math.ceil(w / intervalMin));
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const maxHigh = Math.max(...checkPrev.map((c: any) => c.high));
              if (maxHigh < candle1.high) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (
                //  volumeTf
                 //  &&
                    await this.hasHigherTFConfirmation(symbol, 'SELL')
                  ) {
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
                      historyCheckCandles: numCandles,
                      volumeTimeframe: '4h',
                     interval: interval as '1m' | '5m' | '15m'
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

      // Bullish Engulfing
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
            const historical = await this.publicRest.getKlines({
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
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const baseWindows = [
              //1440, 720, 240, 180, 120, 60, 15,
              15];
            const checkWindows = baseWindows.map(w => Math.ceil(w / intervalMin));
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const minLow = Math.min(...checkPrev.map((c: any) => c.low));
              const patternLow = Math.min(candle1.low, candle2.low);
              if (minLow > patternLow) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (
                 // volumeTf
                  // && 
                   await this.hasHigherTFConfirmation(symbol, 'BUY')
                  ) {
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
                      historyCheckCandles: numCandles,
                      volumeTimeframe: '4h',
                    interval: interval as '1m' | '5m' | '15m'
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

      // Bearish Engulfing
      if (candle4) {
        if ((candle1.high - candle1.low) / candle1.low > maxPercent || (candle2.high - candle2.low) / candle2.low > maxPercent) return;
        if ((candle3.high - candle3.low) / candle3.low > maxPercent) return;
        if ((candle4.high - candle4.low) / candle4.low > maxPercent) return;
        if (
          candle1.close > candle1.open && candle2.open >= candle1.close &&
          candle2.low < candle1.low && candle2.high > candle1.high && candle2.close < candle1.open &&
          candle3.high < candle2.high && candle3.close < candle2.low && candle3.close < candle3.open && candle3.open !== candle3.high &&
          candle4.low < candle3.low && candle4.high < candle3.high
        ) {
          try {
            const historical = await this.publicRest.getKlines({
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
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const baseWindows = [
            //  1440, 720, 240, 180, 120, 60, 15,
              15];
            const checkWindows = baseWindows.map(w => Math.ceil(w / intervalMin));
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const maxHigh = Math.max(...checkPrev.map((c: any) => c.high));
              const patternHigh = Math.max(candle1.high, candle2.high);
              if (maxHigh < patternHigh) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (
                //  volumeTf
                  // && 
                   await this.hasHigherTFConfirmation(symbol, 'SELL')
                  ) {
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
                      historyCheckCandles: numCandles,
                      volumeTimeframe: '4h',
                    interval: interval as '1m' | '5m' | '15m'
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

      // Bullish Harami
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
            const historical = await this.publicRest.getKlines({
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
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const baseWindows = [
             // 1440, 720, 240, 180, 120, 60, 15,
              15];
            const checkWindows = baseWindows.map(w => Math.ceil(w / intervalMin));
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const minLow = Math.min(...checkPrev.map((c: any) => c.low));
              const patternLow = Math.min(candle1.low, candle2.low);
              if (minLow > patternLow) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (
                 // volumeTf
                   //&&
                    await this.hasHigherTFConfirmation(symbol, 'BUY')
                  ) {
                  const sl = candle1.low;
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
                      historyCheckCandles: numCandles,
                      volumeTimeframe: '4h',
                      interval: interval as '1m' | '5m' | '15m'
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

      // Bearish Harami
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
            const historical = await this.publicRest.getKlines({
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
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const baseWindows = [
             // 1440, 720, 240, 180, 120, 60, 15,
              15];
            const checkWindows = baseWindows.map(w => Math.ceil(w / intervalMin));
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const maxHigh = Math.max(...checkPrev.map((c: any) => c.high));
              const patternHigh = Math.max(candle1.high, candle2.high);
              if (maxHigh < patternHigh) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (
                 // volumeTf
                  // &&
                    await this.hasHigherTFConfirmation(symbol, 'SELL')
                  ) {
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
                      historyCheckCandles: numCandles,
                      volumeTimeframe: '4h',
                    interval: interval as '1m' | '5m' | '15m'
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

      // Inside Bar patterns
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

        // Bullish Inside Bar
        if (
          breakout.close > mother.high &&
          breakout.low > mother.low &&
          breakout.close > breakout.open &&
          breakout.open !== breakout.low &&
          confirm.high > breakout.high &&
          confirm.low > breakout.low
        ) {
          try {
             console.log(`BULLISH INSIDE BAR LONG detected and entered: ${symbol} `);
            const historical = await this.publicRest.getKlines({
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
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const baseWindows = [
             // 1440, 720, 240, 180, 120, 60, 15,
              15];
            const checkWindows = baseWindows.map(w => Math.ceil(w / intervalMin));
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const minLow = Math.min(...checkPrev.map((c: any) => c.low));
              const patternLow = mother.low;
              if (minLow > patternLow) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (
                  
                //  volumeTf
                  // &&
                    await this.hasHigherTFConfirmation(symbol, 'BUY')
                  ) {
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
                      historyCheckCandles: numCandles,
                      volumeTimeframe: '4h',
                   interval: interval as '1m' | '5m' | '15m'
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

        // Bearish Inside Bar
        if (
        breakout.close < mother.low &&
        breakout.high < mother.high &&
        breakout.close < breakout.open &&
        breakout.open !== breakout.high &&
        confirm.low < breakout.low &&
        confirm.high < breakout.high
        ) {
          try {
             console.log(`bearish INSIDE BAR SHORT detected and entered: ${symbol})`);
            const historical = await this.publicRest.getKlines({
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
              quoteVolume: Number(k[6]),
              trades: Number(k[8]),
              volumeActive: Number(k[9]),
              quoteVolumeActive: Number(k[10]),
              startTime: Number(k[0]),
              endTime: Number(k[6]),
              isFinal: true
            }));
            const baseWindows = [
             // 1440, 720, 240, 180, 120, 60, 15,
              15];
            const checkWindows = baseWindows.map(w => Math.ceil(w / intervalMin));
            for (const numCandles of checkWindows) {
              const startIdx = maxCandles - numCandles;
              const checkPrev = prev.slice(startIdx);
              const maxHigh = Math.max(...checkPrev.map((c: any) => c.high));
              const patternHigh = mother.high;
              if (maxHigh < patternHigh) {
                const volumeTf = await this.checkVolumeIncrease(symbol);
                if (volumeTf
                  && await this.hasHigherTFConfirmation(symbol, 'SELL')
                  ) {
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
                      historyCheckCandles: numCandles,
                      volumeTimeframe: volumeTf,
                     interval: interval as '1m' | '5m' | '15m'
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
    return lowerShadow >= 1.5 * body && upperShadow <= 0.4 * Math.max(body, 1e-8) && lowerShadow / range >= 0.55
     && c.close > c.open;
  }

  private isInverseHammer(c: any): boolean {
    const body = Math.abs(c.close - c.open);
    const upperShadow = c.high - Math.max(c.open, c.close);
    const lowerShadow = Math.min(c.open, c.close) - c.low;
    const range = c.high - c.low || 1e-8;
    return upperShadow >= 1.5 * body && lowerShadow <= 0.4 * Math.max(body, 1e-8) && upperShadow / range >= 0.55
     && c.close < c.open;
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
        newNextTriggerPrice = this.round(isLong ? newSlTrigger * 1.018 : newSlTrigger / 1.018, precision.pricePrecision);
        newNextSL = this.round(isLong ? newSlTrigger * 1.005 : newSlTrigger / 1.005, precision.pricePrecision);
        newNextTP = this.round(isLong ? newTpTrigger * 1.005 : newTpTrigger / 1.005, precision.pricePrecision);
        newBigMoveTriggerPrice = this.round(isLong ? newSlTrigger * 1.36 : newSlTrigger / 1.36, precision.pricePrecision);
        newBigMoveNextSL = this.round(isLong ? newSlTrigger * 1.30 : newSlTrigger / 1.30, precision.pricePrecision);
        newBigMoveNextTP = this.round(isLong ? newTpTrigger * 1.30 : newTpTrigger / 1.30, precision.pricePrecision);
      } else {
        newNextTriggerPrice = this.round(isLong ? newSlTrigger * 1.018 : newSlTrigger / 1.018, precision.pricePrecision);
        newNextSL = this.round(isLong ? newSlTrigger * 1.005 : newSlTrigger / 1.005, precision.pricePrecision);
        newNextTP = this.round(isLong ? newTpTrigger * 1.005 : newTpTrigger / 1.005, precision.pricePrecision);
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
        state.nextTriggerPrice = this.round(isLong ? state.currentSL * 1.018 : state.currentSL / 1.018, precision.pricePrecision);
        state.nextSL = this.round(isLong ? state.currentSL * 1.005 : state.currentSL / 1.005, precision.pricePrecision);
        state.nextTP = this.round(isLong ? state.currentTP * 1.005 : state.currentTP / 1.005, precision.pricePrecision);
        state.bigMoveTriggerPrice = this.round(isLong ? state.currentSL * 1.36 : state.currentSL / 1.36, precision.pricePrecision);
        state.bigMoveNextSL = this.round(isLong ? state.currentSL * 1.30 : state.currentSL / 1.30, precision.pricePrecision);
        state.bigMoveNextTP = this.round(isLong ? state.currentTP * 1.30 : state.currentTP / 1.30, precision.pricePrecision);
      } else {
        state.nextTriggerPrice = this.round(isLong ? state.currentSL * 1.018 : state.currentSL / 1.018, precision.pricePrecision);
        state.nextSL = this.round(isLong ? state.currentSL * 1.005 : state.currentSL / 1.005, precision.pricePrecision);
        state.nextTP = this.round(isLong ? state.currentTP * 1.005 : state.currentTP / 1.005, precision.pricePrecision);
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
    volumeTimeframe?: string;
    interval: '1m' | '5m' | '15m';
  }) {
    const { userId, symbol, side, stopLoss, takeProfit, isScalping = false, patternType, historyCheckCandles, volumeTimeframe, interval } = params;

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
      volumeTimeframe,
      patternEntryTimeframe: interval
    });

    state.dailyEntryCount++;
    const symbolSideKey = `${symbol}-${targetPositionSide}`;
    state.symbolEntryCounts.set(symbolSideKey, (state.symbolEntryCounts.get(symbolSideKey) || 0) + 1);

    const rootClientId = uuidv4().replace(/-/g, '').substring(0, 14);
    const slClientId = `${this.OUR_CLIENT_PREFIX}_sl-${rootClientId}`;
    const tpClientId = `${this.OUR_CLIENT_PREFIX}_tp-${rootClientId}`;

    this.virtualOrders.set(slClientId, {
      symbol,
      side: side === 'BUY' ? 'SELL' : 'BUY',
      type: 'STOP_MARKET',
      triggerPrice: stopLoss,
      quantity: parseFloat(quantity),
      positionSide: targetPositionSide,
      workingType: 'MARK_PRICE',
      clientAlgoId: slClientId
    });

    this.virtualOrders.set(tpClientId, {
      symbol,
      side: side === 'BUY' ? 'SELL' : 'BUY',
      type: 'TAKE_PROFIT_MARKET',
      triggerPrice: takeProfit,
      quantity: parseFloat(quantity),
      positionSide: targetPositionSide,
      workingType: 'MARK_PRICE',
      clientAlgoId: tpClientId
    });

    const key = `${userId}-${symbol}-${targetPositionSide}-${side}-${slClientId}-${tpClientId}`;
    this.trailingState.set(key, {
      side,
      symbol,
      positionSide: targetPositionSide as any,
      currentSL: stopLoss,
      currentTP: takeProfit,
      qty: quantity,
      trailCount: 0,
      isScalping,
      nextTriggerPrice: this.round(side === 'BUY' ? stopLoss * 1.018 : stopLoss / 1.018, precision.pricePrecision),
      nextSL: this.round(side === 'BUY' ? stopLoss * 1.005 : stopLoss / 1.005, precision.pricePrecision),
      nextTP: this.round(side === 'BUY' ? takeProfit * 1.003 : takeProfit / 1.003, precision.pricePrecision),
      bigMoveTriggerPrice: this.round(side === 'BUY' ? stopLoss * 1.36 : stopLoss / 1.36, precision.pricePrecision),
      bigMoveNextSL: this.round(side === 'BUY' ? stopLoss * 1.30 : stopLoss / 1.30, precision.pricePrecision),
      bigMoveNextTP: this.round(side === 'BUY' ? takeProfit * 1.30 : takeProfit / 1.30, precision.pricePrecision),
      slClientId,
      tpClientId
    });
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


