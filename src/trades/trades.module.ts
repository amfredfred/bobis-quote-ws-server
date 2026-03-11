import { Module } from '@nestjs/common';
import { TradesService } from './trades.service';

@Module({
  providers: [TradesService],
  exports:   [TradesService],
})
export class TradesModule {}
