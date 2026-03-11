'use strict';

import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TradingStyle } from 'src/prisma/generated/enums';

export interface CreateStrategyDto {
  name: string;
  description: string;
  tradingStyle?: TradingStyle;
  tradingHoursStart?: string;
  tradingHoursEnd?: string;
  sessionReminderMins?: number;
  isDefault?: boolean;
}

export interface UpdateStrategyDto extends Partial<CreateStrategyDto> {
  isArchived?: boolean;
  aiRephrasedDesc?: string;
  aiNotes?: string;
  aiParameters?: Record<string, string>;
  aiReminderPhrases?: Record<string, string>;
  aiRiskGuidelines?: Record<string, string>;
  aiChecklistItems?: Record<string, string>;
}

@Injectable()
export class StrategyService {
  constructor(private readonly prisma: PrismaService) { }

  async findAll(userId: string) {
    return this.prisma.tradingStrategy.findMany({
      where: { userId, isArchived: false },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async findOne(id: string, userId: string) {
    const s = await this.prisma.tradingStrategy.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Strategy not found');
    if (s.userId !== userId) throw new ForbiddenException();
    return s;
  }

  async create(userId: string, dto: CreateStrategyDto) {
    if (dto.isDefault) {
      await this.prisma.tradingStrategy.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });
    }
    return this.prisma.tradingStrategy.create({
      data: { userId, ...dto, tradingStyle: dto.tradingStyle as any },
    });
  }

  async update(id: string, userId: string, dto: UpdateStrategyDto) {
    await this.findOne(id, userId);
    if (dto.isDefault) {
      await this.prisma.tradingStrategy.updateMany({
        where: { userId, isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
    }
    return this.prisma.tradingStrategy.update({
      where: { id },
      data: { ...dto, tradingStyle: dto.tradingStyle },
    });
  }

  async delete(id: string, userId: string) {
    await this.findOne(id, userId);
    await this.prisma.tradingStrategy.delete({ where: { id } });
  }

  async getDefault(userId: string) {
    return this.prisma.tradingStrategy.findFirst({
      where: { userId, isDefault: true, isArchived: false },
    });
  }
}
