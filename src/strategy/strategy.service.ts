'use strict';

import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
  ConflictException,
} from '@nestjs/common';
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
  private readonly logger = new Logger(StrategyService.name);

  constructor(private readonly prisma: PrismaService) { }

  async findAll(userId: string) {
    try {
      return await this.prisma.tradingStrategy.findMany({
        where: { userId, isArchived: false },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      });
    } catch (err) {
      this.logger.error(`Failed to fetch strategies for user ${userId}`, err);
      throw new InternalServerErrorException('Could not load your strategies. Please try again.');
    }
  }

  async findOne(id: string, userId: string) {
    let strategy: Awaited<ReturnType<typeof this.prisma.tradingStrategy.findUnique>>;

    try {
      strategy = await this.prisma.tradingStrategy.findUnique({ where: { id } });
    } catch (err) {
      this.logger.error(`Failed to fetch strategy ${id}`, err);
      throw new InternalServerErrorException('Could not load this strategy. Please try again.');
    }

    if (!strategy) throw new NotFoundException(`Strategy not found.`);
    if (strategy.userId !== userId) throw new ForbiddenException('You do not have access to this strategy.');

    return strategy;
  }

  async create(userId: string, dto: CreateStrategyDto) {
    if (!dto.name?.trim()) throw new BadRequestException('Strategy name is required.');
    if (!dto.description?.trim()) throw new BadRequestException('Strategy description is required.');

    try {
      if (dto.isDefault) {
        await this.prisma.tradingStrategy.updateMany({
          where: { userId, isDefault: true },
          data: { isDefault: false },
        });
      }

      return await this.prisma.tradingStrategy.create({
        data: { userId, ...dto, tradingStyle: dto.tradingStyle as any },
      });
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;

      if (err?.code === 'P2002') {
        throw new ConflictException(`A strategy named "${dto.name}" already exists. Please choose a different name.`);
      }

      this.logger.error(`Failed to create strategy for user ${userId}`, err);
      throw new InternalServerErrorException('Could not save your strategy. Please try again.');
    }
  }

  async update(id: string, userId: string, dto: UpdateStrategyDto) {
    if (Object.keys(dto).length === 0) {
      throw new BadRequestException('No fields provided to update.');
    }

    // Ownership check — throws NotFoundException / ForbiddenException if needed
    await this.findOne(id, userId);

    try {
      if (dto.isDefault) {
        await this.prisma.tradingStrategy.updateMany({
          where: { userId, isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }

      return await this.prisma.tradingStrategy.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.description !== undefined && { description: dto.description }),
          ...(dto.tradingStyle !== undefined && { tradingStyle: dto.tradingStyle }),
          ...(dto.tradingHoursStart !== undefined && { tradingHoursStart: dto.tradingHoursStart }),
          ...(dto.tradingHoursEnd !== undefined && { tradingHoursEnd: dto.tradingHoursEnd }),
          ...(dto.sessionReminderMins !== undefined && { sessionReminderMins: dto.sessionReminderMins }),
          ...(dto.isDefault !== undefined && { isDefault: dto.isDefault }),
          ...(dto.isArchived !== undefined && { isArchived: dto.isArchived }),
          ...(dto.aiRephrasedDesc !== undefined && { aiRephrasedDesc: dto.aiRephrasedDesc }),
          ...(dto.aiNotes !== undefined && { aiNotes: dto.aiNotes }),
          ...(dto.aiParameters !== undefined && { aiParameters: dto.aiParameters }),
          ...(dto.aiReminderPhrases !== undefined && { aiReminderPhrases: dto.aiReminderPhrases }),
          ...(dto.aiRiskGuidelines !== undefined && { aiRiskGuidelines: dto.aiRiskGuidelines }),
          ...(dto.aiChecklistItems !== undefined && { aiChecklistItems: dto.aiChecklistItems }),
        },
      });
    } catch (err: any) {
      if (err instanceof NotFoundException || err instanceof ForbiddenException || err instanceof BadRequestException) {
        throw err;
      }

      if (err?.code === 'P2002') {
        throw new ConflictException(`A strategy with that name already exists.`);
      }
      if (err?.code === 'P2025') {
        throw new NotFoundException('Strategy no longer exists.');
      }

      this.logger.error(`Failed to update strategy ${id}`, err);
      throw new InternalServerErrorException('Could not update this strategy. Please try again.');
    }
  }

  async delete(id: string, userId: string) {
    // Ownership check — throws NotFoundException / ForbiddenException if needed
    await this.findOne(id, userId);

    try {
      await this.prisma.tradingStrategy.delete({ where: { id } });
    } catch (err: any) {
      if (err?.code === 'P2025') {
        throw new NotFoundException('Strategy no longer exists.');
      }

      this.logger.error(`Failed to delete strategy ${id}`, err);
      throw new InternalServerErrorException('Could not delete this strategy. Please try again.');
    }
  }

  async getDefault(userId: string) {
    try {
      return await this.prisma.tradingStrategy.findFirst({
        where: { userId, isDefault: true, isArchived: false },
      });
    } catch (err) {
      this.logger.error(`Failed to fetch default strategy for user ${userId}`, err);
      throw new InternalServerErrorException('Could not load your default strategy. Please try again.');
    }
  }
}