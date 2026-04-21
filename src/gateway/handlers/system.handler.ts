'use strict';

import { Injectable } from '@nestjs/common';
import { SystemConfigService } from '../../system/system-config.service';
import type { SystemConfig } from '../../common/types/system-config.types';

@Injectable()
export class SystemHandler {
  constructor(private readonly svc: SystemConfigService) {}

  getConfig(): SystemConfig {
    return this.svc.getConfig();
  }
}
