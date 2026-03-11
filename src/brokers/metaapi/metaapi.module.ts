import { Global, Module } from '@nestjs/common';
import { MetaApiService } from './metaapi.service';

@Global()
@Module({
  providers: [MetaApiService],
  exports:   [MetaApiService],
})
export class MetaApiModule {}
