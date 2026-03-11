import {
  Controller, Get, Post, Patch, Delete, Body, Param,
  Req, UseGuards, HttpCode, HttpStatus, NotFoundException,
} from '@nestjs/common';
import { JwtGuard, type AuthRequest } from '../auth/jwt-auth.guard';
import { AccountsService, type CreateAccountDto, type UpdateAccountDto } from './accounts.service';
import { MetaApiService } from '../brokers/metaapi/metaapi.service';
import { PipelineManager } from '../pipeline/pipeline.manager';

@Controller('accounts')
@UseGuards(JwtGuard)
export class AccountsController {
  constructor(
    private readonly accountsSvc: AccountsService,
    private readonly metaApi: MetaApiService,
    private readonly pipelineMgr: PipelineManager,
  ) { }

  /**
   * Flow:
   * 1. Deploy the broker account to MetaApi cloud (login + password + server)
   * 2. Save the account in our DB with the MetaApi ID (user never sees it)
   * 3. Start the pipeline
   */
  @Post()
  async create(@Req() req: AuthRequest, @Body() dto: CreateAccountDto) {
    // Step 1: deploy to MetaApi — this is where broker credentials are used
    const { metaApiAccountId } = await this.metaApi.deployAccount({
      login: dto.login,
      password: dto.password,
      server: dto.server,
      platform: dto.platform,
      name: dto.name,
      magic: dto.riskConfig?.magicNumber ?? 20240101,
      region: 'london'
    });

    // Step 2: persist — metaApiAccountId stored internally, never returned
    const account = await this.accountsSvc.create(req.user.id, dto, metaApiAccountId);

    // Step 3: start pipeline
    await this.pipelineMgr.startPipeline(account);

    return {
      ...this._safeAccount(account),
      pipeline: this.pipelineMgr.isDegraded(account.id)
        ? { status: 'degraded', ...this.pipelineMgr.getDegradedPipelines().find(d => d.accountId === account.id) }
        : { status: 'running' },
    };
  }

  @Get()
  async findAll(@Req() req: AuthRequest) {
    const accounts = await this.accountsSvc.findByUserId(req.user.id);
    const degraded = this.pipelineMgr.getDegradedPipelines();
    return accounts.map(a => ({
      ...this._safeAccount(a),
      pipeline: this.pipelineMgr.isDegraded(a.id)
        ? { status: 'degraded', error: degraded.find(d => d.accountId === a.id)?.error }
        : this.pipelineMgr.getPipeline(a.id)
          ? { status: 'running' }
          : { status: 'stopped' },
    }));
  }

  @Get(':id')
  async findOne(@Req() req: AuthRequest, @Param('id') id: string) {
    const account = await this.accountsSvc.findOne(id, req.user.id);
    const degraded = this.pipelineMgr.getDegradedPipelines().find(d => d.accountId === id);
    return {
      ...this._safeAccount(account),
      pipeline: degraded
        ? { status: 'degraded', error: degraded.error, failedAt: degraded.failedAt }
        : this.pipelineMgr.getPipeline(id)
          ? { status: 'running', ...this.pipelineMgr.getPipeline(id)?.getSnapshot() }
          : { status: 'stopped' },
    };
  }

  @Patch(':id')
  async update(@Req() req: AuthRequest, @Param('id') id: string, @Body() dto: UpdateAccountDto) {
    const account = await this.accountsSvc.update(id, dto, req.user.id);
    await this.pipelineMgr.restartPipeline(account);
    return this._safeAccount(account);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: AuthRequest, @Param('id') id: string) {
    const account = await this.accountsSvc.findOne(id, req.user.id);
    await this.pipelineMgr.stopPipeline(id);
    // Undeploy from MetaApi cloud so it stops consuming their resources/billing
    await this.metaApi.undeployAccount(account.metaApiAccountId);
    await this.accountsSvc.delete(id, req.user.id);
  }

  @Post(':id/start')
  async start(@Req() req: AuthRequest, @Param('id') id: string) {
    const account = await this.accountsSvc.findOne(id, req.user.id);
    await this.pipelineMgr.startPipeline(account);
    const degraded = this.pipelineMgr.getDegradedPipelines().find(d => d.accountId === id);
    if (degraded) return { status: 'degraded', accountId: id, error: degraded.error };
    return { status: 'started', accountId: id };
  }

  @Post(':id/stop')
  async stop(@Req() req: AuthRequest, @Param('id') id: string) {
    await this.accountsSvc.findOne(id, req.user.id);
    await this.pipelineMgr.stopPipeline(id);
    return { status: 'stopped', accountId: id };
  }

  @Get(':id/trades')
  async getTrades(@Req() req: AuthRequest, @Param('id') id: string) {
    await this.accountsSvc.findOne(id, req.user.id);
    if (this.pipelineMgr.isDegraded(id)) {
      throw new NotFoundException(`Pipeline for account ${id} is degraded and not running`);
    }
    return this.pipelineMgr.getPipeline(id)?.getOpenTrades() ?? [];
  }

  // Strip metaApiAccountId from all responses — internal implementation detail
  private _safeAccount(account: ReturnType<AccountsService['findOne']> extends Promise<infer T> ? T : never) {
    const { metaApiAccountId: _, ...safe } = account; //  as Record<string, unknown>
    return safe;
  }
}
