import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type TradeDocument = HydratedDocument<Trade>;

@Schema({ timestamps: true })
export class Trade {
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
}


export const TradeSchema = SchemaFactory.createForClass(Trade);