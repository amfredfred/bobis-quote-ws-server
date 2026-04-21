'use strict';

import { Module } from '@nestjs/common';
import { SystemConfigService } from './system-config.service';

@Module({
  providers: [SystemConfigService],
  exports: [SystemConfigService],
})
export class SystemModule {}
