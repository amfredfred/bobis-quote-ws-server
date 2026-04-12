'use strict';

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface UpdateProfileDto {
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  notificationPushToken?: string;
  pushEnabled?: boolean;
  strategyReminders?: boolean;
  accountAlerts?: boolean;
  sessionReminders?: boolean;
  drawdownWarnings?: boolean;
  profitTargetAlerts?: boolean;
  signalAlertsEnabled?: boolean;
  maxTradesWarnings?: boolean;
  tradingDaysReminders?: boolean;
  timezone?: string;
}

const avatarStyles = [
  "avataaars",
  "identicon",
  "micah",
  "bottts",
  "lorelei",
  "notionists",
  "adventurer",
  "miniavs",
  "open-peeps",
  "personas",
];


/** Trading-themed adjectives */
const traderAdjectives = [
  "Bull",
  "Bear",
  "Crypto",
  "Prop",
  "Smart",
  "Funded",
  "Alpha",
  "Swing",
  "Day",
  "Scalp",
  "Chart",
  "Forex",
  "Pro",
  "Elite",
  "Prime",
  "Zen",
  "Quick",
  "Flash",
  "Profit",
  "Golden",
];

/** Trading-themed nouns */
const traderNouns = [
  "Trader",
  "Broker",
  "Bull",
  "Bear",
  "Whale",
  "Shark",
  "Tiger",
  "Wolf",
  "Hawk",
  "Eagle",
  "Lion",
  "King",
  "Master",
  "Genius",
  "Legend",
  "Hunter",
  "Sniper",
  "Ninja",
  "Wizard",
  "Phoenix",
];

/** Fun trader display names */
const traderDisplayNames = [
  "The Chart Whisperer",
  "Pip Hunter",
  "Candle Master",
  "Risk Manager",
  "Profit Taker",
  "Trend Rider",
  "Breakout King",
  "Support Sniper",
  "Resistance Breaker",
  "Position Trader",
  "The Liquidator",
  "Diamond Hands",
  "Paper Hands Slayer",
  "Margin Call Survivor",
  "Stop Loss Hero",
  "Take Profit Legend",
  "Bull Run Chaser",
  "Bear Market Ninja",
  "FOMO Fighter",
  "Dip Buyer",
  "Moon Mission Captain",
  "Volatility Lover",
  "Risk Reward Master",
  "Green Candle Collector",
  "Red Candle Warrior",
];

function generateTraderUsername() {
  const adj = traderAdjectives[Math.floor(Math.random() * traderAdjectives.length)];
  const noun = traderNouns[Math.floor(Math.random() * traderNouns.length)];
  const num = Math.floor(Math.random() * 999);
  return `${adj}${noun}${num}`;
}

function generateTraderDisplayName() {
  return traderDisplayNames[Math.floor(Math.random() * traderDisplayNames.length)];
}

function generateRandomAvatar(userId: string) {
  const style = avatarStyles[Math.floor(Math.random() * avatarStyles.length)];
  return `https://api.dicebear.com/9.x/${style}/png?seed=${userId}&size=256`;
}

@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async findOrCreate(userId: string) {
    const username    = generateTraderUsername();
    const displayName = generateTraderDisplayName();
    const avatarUrl   = generateRandomAvatar(userId);

    return this.prisma.profile.upsert({
      where:  { userId },
      update: {},          // already exists — touch nothing
      create: { userId, username, displayName, avatarUrl },
    });
  }

  async findOne(userId: string) {
    const profile = await this.prisma.profile.findUnique({ where: { userId } });
    if (!profile) throw new NotFoundException('Profile not found');
    return profile;
  }

  async update(userId: string, dto: UpdateProfileDto) {
    await this.findOrCreate(userId);
    return this.prisma.profile.update({ where: { userId }, data: dto });
  }

  async updatePushToken(userId: string, token: string) {
    await this.findOrCreate(userId);
    return this.prisma.profile.update({
      where: { userId },
      data: { notificationPushToken: token },
    });
  }

}
