import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type TradeDocument = HydratedDocument<TradeX>;

@Schema({ timestamps: true })
export class TradeX {
  @Prop({ required: true })
  userId: string;

  @Prop({ required: true })
  symbol: string;

  @Prop({ required: true, enum: ['BUY', 'SELL'] })
  side: 'BUY' | 'SELL';

  @Prop({ required: true, enum: ['LONG', 'SHORT'] })
  positionSide: 'LONG' | 'SHORT';

  @Prop({ required: true })
  entryPrice: number;

  @Prop({ required: true })
  exitPrice: number;

  @Prop({ required: true })
  qty: number;

  @Prop({ required: true })
  sl: number;

  @Prop({ required: true })
  tp: number;

  @Prop({ required: true })
  pnl: number;

  @Prop({ required: true })
  entryTime: Date;

  @Prop({ required: true })
  exitTime: Date;

  @Prop({ required: true })
  isWin: boolean;

  @Prop({ required: true, enum: ['SL', 'TP'] })
  exitType: 'SL' | 'TP';

  @Prop({ required: true })
  leverage: number;

  @Prop({ required: true })
  riskAmount: number;

  @Prop({ required: true })
  allocatedMargin: number;

  @Prop({ required: false, type: Number })
  historyCheckCandles?: number; 

  @Prop({ required: false })
volumeTimeframe?: string;  // e.g., '1d', '12h'

  @Prop({
    required: true,
    enum: [
      'HAMMER',
      'INVERSE_HAMMER',
      'BULLISH_ENGULFING',
      'BEARISH_ENGULFING',
      'BULLISH_HARAMI',
      'BEARISH_HARAMI',
      'BULLISH_SPINNING_TOP',
      'BEARISH_SPINNING_TOP',
      'BULLISH_INSIDE_BAR',
      'BEARISH_INSIDE_BAR'
    ]
  })
  patternType:
    | 'HAMMER'
    | 'INVERSE_HAMMER'
    | 'BULLISH_ENGULFING'
    | 'BEARISH_ENGULFING'
    | 'BULLISH_HARAMI'
    | 'BEARISH_HARAMI'
    | 'BULLISH_SPINNING_TOP'
    | 'BEARISH_SPINNING_TOP'
    | 'BULLISH_INSIDE_BAR'
    | 'BEARISH_INSIDE_BAR';

  @Prop({ required: true, enum: ['1m', '5m', '15m'] })
  patternEntryTimeframe: '1m' | '5m' | '15m';
}

export const TradeSchema = SchemaFactory.createForClass(TradeX);



































// src/modules/tradingBotModule/trading-bot.service.ts
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { WebsocketClient, USDMClient, MarginType } from 'binance';
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
  symbolEntryCounts: Map<string, number>; // key: `${symbol}-${positionSide}` 
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
    isScalping: boolean; // ← ONLY THIS LINE ADDED
  }>();
  private serverTimeOffset = 0;
  private readonly OUR_CLIENT_PREFIX = 'x-15PC4ZJy_Xcdr';
  private async getSymbolPrecision(symbol: string) {
  const rest = this.getRestClient('68d3f007099f9de77119b413');
  const info = await rest.getExchangeInfo();
  const s = info.symbols.find((x: any) => x.symbol === symbol);
  if (!s) throw new Error(`Symbol ${symbol} not found`);
  const pricePrecision = s.pricePrecision; // ← this is what you must use for price
  const qtyPrecision = s.quantityPrecision; // ← this is what you must use for quantity
  return { pricePrecision, qtyPrecision };
}
// Perfect rounding – no floating-point garbage
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
    }}

  async onModuleInit() {
  await this.syncServerTime();
  setInterval(() => this.syncServerTime(), 4 * 60 * 60 * 1000);
  const users = [
    '68d3f007099f9de77119b413',
   'sub1-68d3f007099f9de77119b413',
   // 'sub2-68d3f007099f9de77119b413',
  //  'sub3-68d3f007099f9de77119b413',
   // 'sub4-68d3f007099f9de77119b413',
    //'sub5-68d3f007099f9de77119b413',
  ];
  for (const userId of users) {
    await this.initUser(userId);
 setTimeout(() => this.restoreBotStateOnStartup(userId), 8000); // small delay after WS connect
  }}

    async onModuleDestroy() {
    for (const [userId, wsClient] of this.userWsClients) {
      try {
        await wsClient.closeUserDataStream('usdm' as any, 'usdm' as any);
      } catch (err) {
        console.error(`Failed to close WS for ${userId}:`, err);
      }}
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
   //   console.log('ALGO_UPDATE message: ', update);
       }
  this.onUserDataEvent(userId, msg);
});
  wsClient.on('formattedUserDataMessage', (data: any) =>{ this.onUserDataEvent(userId, data)
 // console.log('log formattedUserDataMessage: ', data)
  });
 
 
  wsClient.on('formattedMessage', (data: any) => {
  const updates = Array.isArray(data) ? data : [data];
  for (const update of updates) {
    if (update.eventType !== 'markPriceUpdate') continue;
    const symbol = update.symbol;
    const price = Number(update.markPrice);
    if (!symbol || isNaN(price)) continue;
  //  console.log("gggggggggggggggggggggggjkeeeeeeeeyyyyyyyyyy" ,this.trailingState)
   for (const [key, state] of this.trailingState.entries()) {
  if (state.symbol !== symbol) continue;
  const isLong = state.side === 'BUY';
  const MAIN_USER_ID = '68d3f007099f9de77119b413';
 const bigTriggered = isLong
   ? price >= state.bigMoveTriggerPrice
   : price <= state.bigMoveTriggerPrice;
  if (bigTriggered) {
  if (this.userRestClients.has(MAIN_USER_ID)) {
    this.executeTrail(MAIN_USER_ID, key, state, price).catch((err) => {
    //  console.error(`[TRAIL FAILED] Main account error:`, err);
    });}}
  const shouldTrigger = isLong
    ? price >= state.nextTriggerPrice
    : price <= state.nextTriggerPrice; // SHORT: price neeche jaaye → trigger
  if (shouldTrigger) {
  if (this.userRestClients.has(MAIN_USER_ID)) {
    this.executeTrail(MAIN_USER_ID, key, state, price).catch((err) => {
    //  console.error(`[TRAIL FAILED] Main account error:`, err);
    });}
  } else {
  // console.log(`WAITING → ${symbol.padEnd(10)} ${state.positionSide.padEnd(5)} | Need: ${state.nextTriggerPrice.toFixed(6)} | Now: ${price.toFixed(6)} '}`);
  }
}}});


 if (userId === '68d3f007099f9de77119b413')
    wsClient.subscribeAllMarketMarkPrice('usdm');
    wsClient.subscribeUsdFuturesUserDataStream();
    this.userWsClients.set(userId, wsClient);
    const state = this.getUserState(userId);
    state.ourClientPrefixes = new Set([this.OUR_CLIENT_PREFIX]);
   }
  private isOurBotOrder(clientId: string | undefined): boolean {
    if (!clientId) return false;
    return clientId.startsWith(this.OUR_CLIENT_PREFIX) && (
      clientId.includes('_en-') || clientId.includes('_sl-') || clientId.includes('_tp-') || clientId.includes('_co-')
    );}
  private lastEventId = new Map<string, string>();
  private async onUserDataEvent(userId: string, data: any) {
    if (data.eventId && this.lastEventId.get(userId) === data.eventId) return;
    if (data.eventId) this.lastEventId.set(userId, data.eventId);
    if (data.eventType === 'ORDER_TRADE_UPDATE') {
      const o = data.order;
      const clientId = o.clientOrderId || '';
  if ( ( !this.isOurBotOrder(o.clientOrderId) && o.executionType === 'TRADE' &&
    o.orderStatus === 'FILLED')  ||  (  o.strategyType === 'ALGO_CONDITION' && o.executionType === 'TRADE' &&
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
           // console.log(`TRAILING FULLY CLEARED → ${o.symbol} ${o.positionSide} | Matched & Deleted: ${clientId}`);
            break;
          }}}}

if( (o.originalOrderType === 'STOP_MARKET' || o.originalOrderType === 'TAKE_PROFIT_MARKET'|| o.strategyType === 'ALGO_CONDITION' )
) {
const marginAddKey = `${userId}-marginadd-${o.orderId}`;
if (this.processedMarginAdds?.has(marginAddKey)) {
 // console.log(`DUPLICATE MARGIN ADD BLOCKED → ${o.orderId}`);
} else {
  this.processedMarginAdds ??= new Set();
  this.processedMarginAdds.add(marginAddKey);
//console.log('Processing unwanted position close for: ', o);
const originalQty = Number(o.originalQuantity);
const filledQty = Number(o.lastFilledQuantity);
const realisedRaw = Number(o.realisedProfit); // -ve bhi ho sakta hai
const commission = Number(o.commissionAmount);
let amountToAdd = 0;
if (originalQty === filledQty) {
  amountToAdd = Math.abs(realisedRaw) + commission;
//  console.log(`FULL → Realised: ${realisedRaw} → Treated as +${Math.abs(realisedRaw)} | Comm: ${commission} | Add: ${amountToAdd.toFixed(4)}`);
} else {
  const scale = originalQty / filledQty;
  amountToAdd = Math.abs(realisedRaw) * scale + commission * scale;
 // console.log(`PARTIAL → Realised: ${realisedRaw} → Treated as +${Math.abs(realisedRaw)} × ${scale} | Comm × ${scale} | Add: ${amountToAdd.toFixed(4)}`);
}
    if (amountToAdd > 0.005) { // sirf jab profit > 0.5 USDT ho
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
              type: "1" // 1 = ADD margin
            });
            console.log(`AUTO MARGIN ADDED → ${o.symbol} ${o.positionSide} | +${amountToAdd.toFixed(2)})`);
              this.processedMarginAdds.delete(marginAddKey);
          }
        } catch (err: any) {
          console.error(`[${userId}] AUTO MARGIN ADD FAILED → ${o.symbol}`, err.message);
              this.processedMarginAdds.delete(marginAddKey);
        }
      }, 2000); // thoda delay so liquidation avoid ho
    } else{
      this.processedMarginAdds.delete(marginAddKey);
//  console.log("Amount too small, skipped");
    }}}}



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
     // console.log('Account Update:', data.updateData.updatedBalances);
        break;
      case 'MARGIN_CALL':
        console.log('Margin Call:', data);
        break;
      case 'ORDER_TRADE_UPDATE':
      // console.log('Order Trade Update:', data);
        break;
      case 'CONDITIONAL_ORDER_TRIGGER_REJECT':
      // console.log('Conditional Order Trigger Reject:', data);
        break;
      case 'kline':
      // console.log('Kline Update:', data);
        break;
      case 'markPriceUpdate':
        console.log('Mark Price Update:', data);
        break;
      case 'liquidationOrder':
        console.log('Liquidation Order:', data);
        break;
      case '24hrTicker':
        console.log('24hr Ticker Update:', data);
        break;
      default:
     // console.log('Unknown event type:', data);
    }}


  

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
//console.log("we recieve openorders",openOrders)
  } catch (e) {
   //  console.warn(`[${userId}] Could not fetch open orders, assuming old orders gone`);
  }
  if (!oldSlExists && !oldTpExists) {
    this.trailingState.delete(oldkey);
    return; // ← Nothing to do, safe exit
  }
  const precision = await this.getSymbolPrecision(symbol);
  const rootClientId = uuidv4().replace(/-/g, '').substring(0, 14);
  const newSlId = `${this.OUR_CLIENT_PREFIX}_sl-${rootClientId}`;
  const newTpId = `${this.OUR_CLIENT_PREFIX}_tp-${rootClientId}`;
  const isScalping = state.isScalping;
  const triggerMul = isScalping ? 1.03 : 1.11;
  const moveMul = isScalping ? 1.01 : 1.04;
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
    //  console.log(`Placed new SL order: ${newSlId} at ${newSlTrigger}`);
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
    //  console.log(`Placed new TP order: ${newTpId} at ${newTpTrigger}`);
    } catch (e) { tpOk = false; console.error(`TP failed`, e); }
    if (tpOk) try { await rest.cancelAlgoOrder({  clientAlgoId: state.tpClientId }); } catch {}
    if (slOk && tpOk) {
      const newKey = `${userId}-${symbol}-${positionSide}-${side}-${newSlId}-${newTpId}`;
      const newCurrentSL = newSlTrigger;
      const newCurrentTP = newTpTrigger;
      let newBigMoveTriggerPrice = state.bigMoveTriggerPrice;
      let newBigMoveNextSL = state.bigMoveNextSL;
      let newBigMoveNextTP = state.bigMoveNextTP;
      if (isBigMove) {
        // Only recalculate big move levels when big move triggered
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
   // console.log("trailing state,",this.trailingState);
  } else {
    // Reject placement, update state in place with new levels based on current
    state.nextTriggerPrice = this.round(isLong ? state.currentSL * triggerMul : state.currentSL / triggerMul, precision.pricePrecision);
    state.nextSL = this.round(isLong ? state.currentSL * moveMul : state.currentSL / moveMul, precision.pricePrecision);
    state.nextTP = this.round(isLong ? state.currentTP * moveMul : state.currentTP / moveMul, precision.pricePrecision);
    if (isBigMove) {
      state.bigMoveTriggerPrice = this.round(isLong ? state.currentSL * BigTriggerMul : state.currentSL / BigTriggerMul, precision.pricePrecision);
      state.bigMoveNextSL = this.round(isLong ? state.currentSL * BigMoveMul : state.currentSL / BigMoveMul, precision.pricePrecision);
      state.bigMoveNextTP = this.round(isLong ? state.currentTP * BigMoveMul : state.currentTP / BigMoveMul, precision.pricePrecision);
    }
  
  }}



// CLOSE UNWANTED POSITIONS
private async closeUnwantedPosition(userId: string, symbol: string) {
  try {
    const rest = this.getRestClient(userId);
    const allPos = (await rest.getPositionsV3())
      .filter((p: any) => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt || '0')) > 0.0001);
    // console.log('log all positions data: ', allPos);
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
      return match ? match[1] : ''; };
    for (const pos of allPos) {
    // console.log('log unwanted position data: ', pos);
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
        }}
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
        } }
    // console.log(`[${userId}] Checking excess qty on ${symbol}: Current Qty=${currentQty}, Valid Bot Qty=${validQtyFromBot}`);
      const excessQty = absQty - validQtyFromBot;
      if (excessQty <= 0.0001) {
        console.log(`[${userId}] No excess qty on ${symbol} ${positionSide}, only cleaned ghost orders`);
        continue;
      }
      const rootClientId = uuidv4().replace(/-/g, '').substring(0, 14);
      const closeClientId = `${this.OUR_CLIENT_PREFIX}_co-${rootClientId}`;
    // console.log(`[${userId}] CLOSING EXCESS ${excessQty.toFixed(3)} on ${symbol} ${positionSide}`);
      const rrrr = await this.placeOrder(userId, {
        symbol,
        side: closeSide,
        type: 'MARKET',
        quantity: excessQty.toFixed(5),
        positionSide: positionSide as 'LONG' | 'SHORT' | 'BOTH',
        newClientOrderId: closeClientId,
        closePosition: 'false'
      });
    // console.log(`[${userId}] EXCESS CLOSED → ${symbol} ${rrrr} reduced by ${excessQty}`);
    }
  } catch (e) {
  // console.error(`[${userId}] Close unwanted failed`, e);
  } finally {
    const prefix = `${userId}-${symbol}-`;
    for (const key of [...this.processingClose.keys()]) {
      if (key.startsWith(prefix)) {
        this.processingClose.delete(key);
      // console.log(`[${userId}] LOCK FREED (SUCCESS) → ${key}`);
      }}}}


private async restoreBotStateOnStartup(userId: string) {
  try {
  // console.log(`[${userId}] Restoring bot state on server start...`);
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
    // Process every position that has our bot SL/TP orders
    for (const pos of positions) {
      const rawAmt = pos.positionAmt || '0';
      if (Math.abs(parseFloat(rawAmt as string)) < 0.0001) continue;
      const symbol = pos.symbol;
      const positionSide = pos.positionSide as 'LONG' | 'SHORT' | 'BOTH';
      const side = positionSide === 'LONG' ? 'BUY' : 'SELL';
      const precision = await this.getSymbolPrecision(symbol);
      // Find ALL our bot STOP_MARKET orders for this symbol + side
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
        if (!ourTP) continue; // Skip if no matching TP
        const currentSL = Number(ourSL.stopPrice);
        const currentTP = Number(ourTP.stopPrice);
        const qty = ourSL.origQty;
        const key = `${userId}-${symbol}-${positionSide}-${side}-${ourSL.clientOrderId}-${ourTP.clientOrderId}`;
        const isScalping = false; // Safe default (tu chahe to future me detect kar sakta hai)
        const firstTriggerMul = isScalping ? 1.002 : 1.02; // 1.5% ya 2%
        const firstMoveMul = isScalping ? 1.003 : 1.03; // 0.3% ya 0.4%
      const triggerMul = isScalping ? 1.25 : 1.34;  // 25% scalping, 34% swing
const moveMul    = isScalping ? 1.18 : 1.25;  // 20% scalping, 30% swing
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
      }}
    // Clean unwanted positions (same as before)
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
    // MARKET ORDER → purana endpoint
    if (params.type === 'MARKET') {
      baseParams.type = 'MARKET';
      return await restClient.submitNewOrder(baseParams);
    }
    // SL / TP → naye ALGO endpoint
    if (params.type === 'STOP_MARKET' || params.type === 'TAKE_PROFIT_MARKET') {
      baseParams.type = params.type;
      if (params.triggerPrice !== undefined) {
        baseParams.triggerPrice = params.triggerPrice.toString();
      }
      baseParams.algoType = 'CONDITIONAL';                    // ← ye mandatory hai
      baseParams.clientAlgoId = params.newClientOrderId || uuidv4().slice(0, 32); // ← ye bhi daal do
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
        symbolEntryCounts: new Map<string, number>(), // ← NEW
      });
    }
    return this.userStates.get(userId)!;
  }
  private getUserConfig(userId: string): UserTradingConfig {
    const configs: Record<string, UserTradingConfig> = {
      '68d3f007099f9de77119b413': {
   API_KEY: 'iTJJoBOzgW8YejbaFtyGbbLxxDiyAZXzc7j92UqEHchnI19qnuXLEaj',
 API_SECRET: 'SjJihZC0OfVvcmJBkW6lZRHPjldIcGPU77l5WhT',
        RISK_PERCENT: 0.4,
        LEVERAGE: 15,
        MARGIN_TYPE: 'ISOLATED',
        HEDGE_MODE: true,
      },
     'sub1-68d3f007099f9de77119b413': { API_KEY: 'yr5VvgNaHvTcjuiB7JNdTJkDNFjxHWIholXgf7lWmlJqsncVjopO6c7quQrR', API_SECRET: 'JzWuTpmyQxGS7BAyUwfBuSofHCM7Md3KGNgLXlvSKAn8G8uB5TVAs7gG7kKeueER', RISK_PERCENT: 0, LEVERAGE: 0, MARGIN_TYPE: 'ISOLATED', HEDGE_MODE: true },
      'sub2-68d3f007099f9de77119b413': { API_KEY: 'UcfPb0HxeIjrq7iPOz0ws6JjL0Ta0j3uPlJBxMKYLMvBA4mfNA4xP', API_SECRET: 'piZHMkSkK3w54xZXyCyjwG29WWogmK2Rm0mDrRm7rVyOgLNiKNWAa5C6g9i2JP0H', RISK_PERCENT: 0, LEVERAGE: 0, MARGIN_TYPE: 'ISOLATED', HEDGE_MODE: false },
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
  //  console.log(`[${userId}] RESTING MODE ACTIVATED: ${minutes}m`);
    return { success: true, message: `Resting for ${minutes}m` };
  }
  public deactivateRestingMode(userId: string): { success: boolean; message: string } {
    const state = this.getUserState(userId);
    if (!state.restingMode.enabled || Date.now() > state.restingMode.until) {
      return { success: false, message: 'Resting mode is already inactive' };
    }
    state.restingMode = { enabled: false, until: 0, duration: 0 };
   // console.log(`[${userId}] RESTING MODE DEACTIVATED`);
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
  // -----------------------------------------------------------------
  // BURST MODE
  // -----------------------------------------------------------------
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
  //  console.log(`[${userId}] Burst Mode ACTIVATED: 3 entries with 1-min gap`);
    return { success: true };
  }
  public deactivateBurstMode(userId: string): { success: boolean; message?: string } {
    const state = this.getUserState(userId);
    if (!state.burstModeEnabled) {
      return { success: false, message: 'Burst mode is already inactive' };}
    state.burstModeEnabled = false;
    state.burstEntriesLeft = 0;
   // console.log(`[${userId}] Burst Mode DEACTIVATED manually`);
    return { success: true, message: 'Burst mode deactivated' };
  }
  public resetDailyCounters(userId: string) {
    const state = this.getUserState(userId);
    const now = new Date();
    // Convert current UTC time to IST date (for daily reset at 00:00 IST)
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // +5:30 hours
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
        }}
      // Clear only counts that have NO active position
      for (const key of state.symbolEntryCounts.keys()) {
        if (!activeKeys.has(key)) {
          state.symbolEntryCounts.delete(key);
        }}
    }).catch(() => {});
    //  console.log(`[${userId}] Daily counters reset at 00:00 IST (UTC+5:30)`);
    }}
  // -----------------------------------------------------------------

  private isTradingHours(): boolean {
    const now = new Date();
    const utcHours = now.getUTCHours();
    const utcMinutes = now.getUTCMinutes();
    const utcTotalMinutes = utcHours * 60 + utcMinutes;
    const startTradingUTC = 4 * 60 + 30; // 04:30 UTC
    const endTradingUTC = 14 * 60 + 30; // 14:30 UTC
    return utcTotalMinutes >= startTradingUTC && utcTotalMinutes < endTradingUTC;
  }
 private canPlaceEntry(userId: string): { allowed: boolean; reason?: string } {
    const state = this.getUserState(userId);
    this.resetDailyCounters(userId);
    if (state.dailyEntryCount >= 10) {
      return { allowed: false, reason: 'Max 10 entries/day reached' };
    }
    if (!state.lastEntryTime) {
      return { allowed: true };
    }
    const now = Date.now();
    const elapsed = now - state.lastEntryTime;
    if (state.burstEntriesLeft > 0) {
      if (elapsed < 60_000) {
        return { allowed: false, reason: 'Wait 1 min in burst' };
      }
      return { allowed: true };
    }
 const minGapMs = this.isTradingHours() ? 120 * 60 * 1000 : 60 * 60 * 1000;
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
  // ---------------------------------------------------------------
  // 1. SETUP – unchanged (20× leverage + ignore -4046/-4059)
  // ---------------------------------------------------------------
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
    //  console.log(`[${userId}] USDT Balance:`, balance);
      return parseFloat(balance);
    } catch (error) {
    //  console.error(`[${userId}] Error retrieving balance:`, error);
      return 0;
    }}


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
      }}
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
     // console.error(`[${userId}] Failed to fetch symbols:`, err.message);
      return ['BTCUSDT', 'ETHUSDT'];
    }} 


  // ADD THIS HELPER before placeFullOrder
private canEnterSymbolSide(userId: string, symbol: string, positionSide: 'LONG' | 'SHORT'): { allowed: boolean; reason?: string } {
  const state = this.getUserState(userId);
  const key = `${symbol}-${positionSide}`;
  const count = state.symbolEntryCounts.get(key) || 0;
  if (count >= 3) {
    return { allowed: false, reason: `Max 3 entries/day for ${symbol} ${positionSide}` };
  }
  return { allowed: true };
}
  // -----------------------------------------------------------------
  // ORDER PREFLIGHT ok
  // -----------------------------------------------------------------
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
  //   const riskAmount = ((2) / 100) * balance;
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
    };}
  // ---------------------------------------------------------------
  // 2. FULL ORDER – **ALWAYS generate rootClientId on backend**
  // ---------------------------------------------------------------
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
  }) {
    const { userId, symbol, side, type, stopPrice, stopLoss, takeProfit,riskPercent,isScalping = false } = params;
      const precision = await this.getSymbolPrecision(symbol); // ← NEW
    const ALLOWED_ACCOUNT_ID = "68d3f007099f9de77119b413";
  if (userId !== ALLOWED_ACCOUNT_ID) {
    console.log(`ENTRY BLOCKED → Unauthorized user: ${userId}`);
    throw new Error("Trading is restricted to main account only");
  }
    const rootClientId = uuidv4().replace(/-/g, '').substring(0, 14);
    const entryClientId = `${this.OUR_CLIENT_PREFIX}_en-${rootClientId}`;
    const slClientId = `${this.OUR_CLIENT_PREFIX}_sl-${rootClientId}`;
    const tpClientId =`${this.OUR_CLIENT_PREFIX}_tp-${rootClientId}`;
    const state = this.getUserState(userId);
    if (!['MARKET'].includes(type)) {
      throw new Error('Only MARKET allowed');
    }
    if (this.isRestingModeActive(userId)) {
      throw new Error('ENTRY BLOCKED: Resting mode active');
    }
    const targetPositionSide = side === 'BUY' ? 'LONG' : 'SHORT';
    const symbolLimit = this.canEnterSymbolSide(userId, symbol, targetPositionSide);
  if (!symbolLimit.allowed) {
    throw new Error(`ENTRY BLOCKED: ${symbolLimit.reason}`);
  }
  const openOrders = await this.getPendingOrders(userId, symbol);
  const slTpCount = openOrders.filter(o =>
    o.positionSide === targetPositionSide &&
    ['STOP_MARKET', 'TAKE_PROFIT_MARKET'].includes(o.algoType)
  ).length;
  if (slTpCount >= 8) {
    throw new Error(`ENTRY BLOCKED: Max 8 SL/TP per symbol on ${targetPositionSide} side (current: ${slTpCount})`);
  }
    const canEnter = this.canPlaceEntry(userId);
    if (!canEnter.allowed) {
      throw new Error(`ENTRY BLOCKED: ${canEnter.reason}`);
    }
    await this.setupTradingMode(userId, symbol);
    const balance = await this.getUsdtBalance(userId);
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
  //  const riskAmount = ((4)/ 100) * balance;
    const rawQty = riskAmount / priceDiff;
    let quantity = rawQty < 1 ? rawQty.toFixed(precision.qtyPrecision) : Math.round(rawQty).toString();
    const notionalEntry = parseFloat(quantity) * markPrice;
    const notionalSL = parseFloat(quantity) * stopLoss;
    const notionalTP = parseFloat(quantity) * takeProfit;
    if (notionalEntry < 5 || notionalSL < 5 || notionalTP < 5) {
      throw new Error(`Notional <5: Entry=${entryPrice}, SL=${stopLoss}, TP=${takeProfit}`);
    }
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
      //  console.log(`[${userId}] Burst Mode ENDED. Normal gaps resume.`);
      }
    }
   // console.log("ghghghghghfgfhgg",entryOrder)
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
    const cv=  await this.placeOrder(userId, {
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
     // console.log("cvvvcvvcv",cv)
    } catch (e) {
      slOk = false;
    //  console.error(`[${userId}] SL placement failed → will close position`, e);
    }
    let tpOk = true;
    try {
    const io=   await this.placeOrder(userId, {
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
     // console.log("ioioioioio",io)
    } catch (e) {
      tpOk = false;
     // console.error(`[${userId}] TP placement failed → will close position`, e);
    }
if (slOk && tpOk) {
 const state = this.getUserState(userId);
  const symbolSideKey = `${symbol}-${targetPositionSide}`;
  const currentCount = (state.symbolEntryCounts.get(symbolSideKey) || 0) + 1;
  state.symbolEntryCounts.set(symbolSideKey, currentCount);
 // console.log(`[${userId}] Entry counted → ${symbolSideKey} = ${currentCount}/5`);
      const PositionSide = side === 'BUY' ? 'LONG' : 'SHORT';
         const key = `${userId}-${symbol}-${PositionSide}-${side}-${slClientId}-${tpClientId}`;
      const firstTriggerMul = isScalping ? 1.02 : 1.03; // 1% or 2%
      const firstMoveMul = isScalping ? 1.003 : 1.004; // 0.3% or 0.4%
      const BigTriggerMul = isScalping ? 1.25 : 1.34; // 25% or 33%
      const BigMoveMul = isScalping ? 1.18 : 1.25; // 20% or 29%
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
       bigMoveNextSL: this.round(side === 'BUY' ? stopLoss *  BigMoveMul: stopLoss /  BigMoveMul, precision.pricePrecision),
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
       // console.log(`[${userId}] Position closed because SL/TP missing`);
      } catch (closeErr) {
      //  console.error(`[${userId}] Failed to close position after SL/TP error`, closeErr);
      }
      throw new Error('SL/TP placement failed – position closed');
    }
    return { clientId: rootClientId, quantity: filledQty, entryPrice, balance };
  }
 // -----------------------------------------------------------------
  // OTHER PUBLIC METHODS (unchanged)
  // -----------------------------------------------------------------
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
    } catch (error) {
    //  console.error(`[${userId}] getOpenPositions failed:`, error);
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
    // console.log('Close position order response:', close);
      return {
        success: true,
        message: `${symbol} Position Closed Successfully`
      };
    } catch (error: any) {
     // console.log('Error closing position:', error);
      return {
        success: false,
        message: `Failed: ${error.message}`
      };}}



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
   // console.log('Original Client ID:', clientId, 'Modified Client ID for replacement:', RelaceClientId);
    if (!newPrice || newPrice <= 0) {
      const msg = `Invalid ${type} price: ${newPrice}`;
    // console.log(`[${userId}] Modify ${type} BLOCKED → ${msg}`);
      return { success: false, message: msg }; }
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
     // console.error(`[${userId}] ${msg}`);
      return { success: false, message: msg };
    }
    if (type === 'SL') {
      if (side === 'BUY' && newPrice >= oldPrice) {
        const msg = `Cannot increase loss: New SL (${newPrice}) >= Old SL (${oldPrice})`;
       // console.log(`[${userId}] Modify SL BLOCKED → ${msg}`);
        return { success: false, message: msg };}
      if (side === 'SELL' && newPrice <= oldPrice) {
        const msg = `Cannot increase loss: New SL (${newPrice}) <= Old SL (${oldPrice})`;
      // console.log(`[${userId}] Modify SL BLOCKED → ${msg}`);
        return { success: false, message: msg }; }}
    let valid = false;
    let reason = '';
    if (type === 'SL') {
      if (side === 'SELL' && newPrice < marketPrice) valid = true;
      else if (side === 'BUY' && newPrice > marketPrice) valid = true;
      else reason = `SL must be ${side === 'SELL' ? 'below' : 'above'} market (${marketPrice.toFixed(5)})`;}
    if (type === 'TP') {
      if (side === 'SELL' && newPrice > marketPrice) valid = true;
      else if (side === 'BUY' && newPrice < marketPrice) valid = true;
      else reason = `TP must be ${side === 'SELL' ? 'above' : 'below'} market (${marketPrice.toFixed(5)})`; }
    if (!valid) {
    // console.log(`[${userId}] BLOCK → ${reason}`);
      return { success: false, message: reason }; }
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
    // console.log('Modify order result:', modifyResult);
    // console.log(`[${userId}] NEW ${type} ORDER PLACED → ${clientId} @ ${newPrice}`);
    if (
      modifyResult.timeInForce==='GTE_GTC'){
      try {
        await restClient.cancelAlgoOrder({
           clientAlgoId:params.clientId
        });
      //  console.log("training state before update:", this.trailingState);
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
      if (type === 'TP') state.tpClientId = RelaceClientId; }
    state.trailCount = 1; // ← Force kar diya!
  const isScalping = state.isScalping;
  const triggerMul = isScalping ? 1.02 : 1.10;
  const moveMul    = isScalping ? 1.01 : 1.04;
  state.nextTriggerPrice = this.round(isLong ? state.currentSL * triggerMul : state.currentSL / triggerMul, precision.pricePrecision);
  state.nextSL = this.round(isLong ? state.currentSL * moveMul : state.currentSL / moveMul, precision.pricePrecision);
  state.nextTP = this.round(isLong ? state.currentTP * moveMul : state.currentTP / moveMul, precision.pricePrecision);
  const bigTriggerMul = isScalping ? 1.030 : 1.34;
  const bigMoveMul    = isScalping ? 1.025 : 1.30;
  state.bigMoveTriggerPrice = this.round(isLong ? state.currentSL * bigTriggerMul : state.currentSL / bigTriggerMul, precision.pricePrecision);
  state.bigMoveNextSL = this.round(isLong ? state.currentSL * bigMoveMul : state.currentSL / bigMoveMul, precision.pricePrecision);
  state.bigMoveNextTP = this.round(isLong ? state.currentTP * bigMoveMul : state.currentTP / bigMoveMul, precision.pricePrecision);
 // console.log(`[${userId}] MANUAL MODIFY → FORCED 10% TRAILING MODE | SL: ${state.currentSL} | Next Trigger: ${state.nextTriggerPrice}`);
    break;
  }}
//console.log("trailing state after update:", this.trailingState);
   } catch (cancelErr: any) { }
    } else{
      throw new Error('Modify order placement failed'); }
      return { success: true, message: `${type} updated to ${newPrice.toFixed(5)}` };
    } catch (error: any) {
      const errMsg = error?.message || error?.toString() || 'Unknown error';
      console.error(`[${userId}] MODIFY ${type} FAILED → ${errMsg}`);
      return { success: false, message: `Modify failed: ${errMsg}` };
    }}
  async enableHedgeMode(userId: string) {
    const restClient = this.getRestClient(userId);
    return restClient.setPositionMode({ dualSidePosition: 'true' } as any);}
  async setLeverage(userId: string, symbol: string, leverage: number) {
    const restClient = this.getRestClient(userId);
    return restClient.setLeverage({ symbol, leverage });}
  async retrieveRateLimit(userId: string) {
    const restClient = this.getRestClient(userId);
    try {
    // const rateLimit = await restClient.getRateLimitStates();
      // console.log('Rate Limit:', rateLimit);
    } catch (error) {
    // console.error('Error retrieving rate limit states:', error);
    }}



  public async addManualMargin(params: {
    userId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    amount: number;
  }): Promise<{ success: boolean; message: string }> {
    const { userId, symbol, side, amount } = params;
    if (!symbol || !side || amount <= 0) {
      return { success: false, message: 'Invalid: symbol, side, amount > 0 required' };}
    try {
      const restClient = this.getRestClient(userId);
      const positionSide = side === 'BUY' ? 'LONG' : 'SHORT';
      await restClient.setIsolatedPositionMargin({
        symbol,
        positionSide,
        amount,
        type: "1"
      });
    //  console.log(`[${userId}] MANUAL MARGIN +${amount} USDT → ${symbol} ${side}`);
      return { success: true, message: `+${amount} USDT added` };
    } catch (err: any) {
    //  console.error(`[${userId}] Manual margin failed:`, err.message);
      return { success: false, message: `Failed: ${err.message}` };
    }}
 public getBotStatus(userId: string) {
  this.retrieveRateLimit(userId);
  const state = this.getUserState(userId);
  const now = Date.now();
  // Resting mode auto expire
  if (state.restingMode.enabled && now > state.restingMode.until) {
    state.restingMode = { enabled: false, until: 0, duration: 0 };
    console.log(`[${userId}] Resting mode expired in status check`);}
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
}}



