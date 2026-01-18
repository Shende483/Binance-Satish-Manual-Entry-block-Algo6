


import { IsString, IsNotEmpty, IsNumber, IsOptional } from 'class-validator';

export class OrderData{
  @IsString()
  @IsNotEmpty()
  symbol: string;

  @IsString()
  @IsNotEmpty()
  entryType: 'buy' | 'sell';

   @IsString()
  @IsNotEmpty()
  orderType: 'Market' | 'Stop'| 'Limit';

    @IsNumber()
  @IsOptional()
  entryPrice?: number;

  @IsString()
  @IsOptional()
  comment?: string;
  
  @IsNumber()
  @IsOptional()
  lotSize?: number;

  @IsNumber()
  @IsOptional()
  stopLoss?: number;

  @IsOptional()
  @IsNumber({}, { each: true }) // Validates number or array of numbers
  takeProfit?: number | number[];

  @IsString()
  @IsOptional()
  _id:string;
  
  timestamp: any;
 

}

