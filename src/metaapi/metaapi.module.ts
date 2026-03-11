import { Module } from "@nestjs/common";
import { MetaApiService } from "./metaapi.service";

@Module({
  providers: [MetaApiService],
  exports: [MetaApiService],
})
export class MetaApiModule {}
