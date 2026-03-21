'use strict';

/**
 * subscription.handler.ts
 *
 * Pure RevenueCat handler — RC is the single source of truth for both
 * mobile (Android/iOS) and web (RC Billing) subscriptions.
 *
 * RC Billing setup required in your RC dashboard before web checkout works:
 *   1. Dashboard → RC Billing → enable it for your project
 *   2. Create an RC Billing product, set price + entitlement
 *   3. Add it to your offering packages alongside the Play/AppStore products
 *
 * Required env vars:
 *   REVENUECAT_API_KEY      — v2 secret key  (sk_...)
 *   REVENUECAT_PROJECT_ID   — project UUID   (proj...)
 *   APP_URL                 — your web app URL for checkout redirects
 *
 * Commands:
 *   subscription.plans    → current offering packages (RC Billing only)
 *   subscription.checkout → RC Billing checkout session → { url }
 *   subscription.portal   → management_url from v1 subscriber → { url }
 *   subscription.cancel   → cancel active sub via v2
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

const RC_V1 = 'https://api.revenuecat.com/v1';
const RC_V2 = 'https://api.revenuecat.com/v2';

@Injectable()
export class SubscriptionHandler {
  private readonly logger = new Logger(SubscriptionHandler.name);

  private get apiKey()    { return process.env['REVENUECAT_API_KEY']    ?? ''; }
  private get projectId() { return process.env['REVENUECAT_PROJECT_ID'] ?? ''; }
  private get appUrl()    { return (process.env['APP_URL'] ?? 'http://localhost:5173').replace(/\/$/, ''); }

  constructor(private readonly prisma: PrismaService) {}

  // ── Shared ─────────────────────────────────────────────────────────────────

  private get headers() {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    };
  }

  private assertConfigured() {
    if (!this.apiKey || !this.projectId) {
      throw new Error('RevenueCat not configured. Set REVENUECAT_API_KEY and REVENUECAT_PROJECT_ID.');
    }
  }

  /** Resolve RC app_user_id — falls back to Supabase userId if not yet linked. */
  private async getRcUserId(userId: string): Promise<string> {
    const profile = await this.prisma.profile.findUnique({
      where:  { userId },
      select: { revenuecatAppUserId: true },
    });
    return profile?.revenuecatAppUserId ?? userId;
  }

  /** GET helper against RC v2. */
  private async rcGet(path: string): Promise<any> {
    const res = await fetch(`${RC_V2}/projects/${this.projectId}${path}`, {
      headers: this.headers,
    });
    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`RC GET ${path} → ${res.status}: ${body}`);
      throw new Error(`RevenueCat error ${res.status}`);
    }
    return res.json();
  }

  /** GET v1 subscriber object (management_url, active subscriptions). */
  private async getSubscriberV1(rcUserId: string): Promise<any> {
    const res = await fetch(
      `${RC_V1}/subscribers/${encodeURIComponent(rcUserId)}`,
      { headers: this.headers },
    );
    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`RC v1 /subscribers → ${res.status}: ${body}`);
      throw new Error('Could not load subscription information.');
    }
    return (await res.json())?.subscriber ?? {};
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  /**
   * Return plans from the current RC offering.
   * Only packages that have an RC Billing product (prices array present) are
   * returned — Play/AppStore-only packages are silently skipped because they
   * cannot be purchased on web.
   *
   * If no RC Billing products exist yet, returns [] with a server-side warning
   * telling you exactly what to do in the RC dashboard.
   */
  async getPlans(): Promise<any[]> {
    if (!this.apiKey || !this.projectId) {
      this.logger.warn('RevenueCat not configured — returning empty plans');
      return [];
    }

    try {
      // Single request: expand packages + their products inline
      const data = await this.rcGet('/offerings?expand=items.package.product');
      const offerings: any[] = data?.items ?? [];

      // Use the current offering; fall back to first one
      const offering = offerings.find((o: any) => o.is_current) ?? offerings[0];
      if (!offering) {
        this.logger.warn('No RC offerings found');
        return [];
      }

      const packages: any[] = offering?.packages?.items ?? [];
      const plans: any[] = [];

      for (const pkg of packages) {
        const productItems: any[] = pkg?.products?.items ?? [];

        // Find the RC Billing product — identified by having a prices array
        const rcBillingProduct = productItems
          .map((pi: any) => pi?.product ?? pi)
          .find((p: any) => Array.isArray(p?.prices) && p.prices.length > 0);

        if (!rcBillingProduct) {
          // Play / AppStore product only — not purchasable on web, skip
          this.logger.debug(
            `Package ${pkg?.lookup_key} skipped — no RC Billing product attached. ` +
            `To fix: RC Dashboard → Offerings → ${offering.lookup_key} → ` +
            `${pkg?.lookup_key} → add an RC Billing product.`
          );
          continue;
        }

        const price       = rcBillingProduct.prices[0] ?? {};
        const priceAmount = Number(price?.amount ?? 0);
        const priceString = price?.display_amount
          ?? (priceAmount
            ? new Intl.NumberFormat('en-US', { style: 'currency', currency: price?.currency ?? 'USD' })
                .format(priceAmount)
            : '');

        const duration   = rcBillingProduct?.subscription?.duration ?? '';
        const periodUnit = this._normalisePeriod(pkg?.lookup_key ?? duration);

        const periodLabel: Record<string, string> = {
          month: 'Monthly', year: 'Annual', week: 'Weekly', day: 'Daily',
        };

        plans.push({
          id:          pkg.id,
          lookupKey:   pkg.lookup_key,
          name:        pkg.display_name ?? rcBillingProduct.display_name ?? periodLabel[periodUnit] ?? 'Plan',
          description: rcBillingProduct.description ?? '',
          priceAmount,
          priceString,
          currency:    (price?.currency ?? 'USD').toUpperCase(),
          periodUnit,
          features:    rcBillingProduct.metadata?.features ?? offering.metadata?.features ?? [],
          popular:     pkg.metadata?.popular === true || offering.metadata?.popular === true,
        });
      }

      if (plans.length === 0) {
        this.logger.warn(
          `Offering "${offering.lookup_key}" has no RC Billing products. ` +
          `Enable RC Billing in your RC dashboard and attach web products to your packages.`
        );
      }

      return plans;
    } catch (err) {
      this.logger.error('getPlans failed', err);
      return [];
    }
  }

  /** Create RC Billing checkout session → { url } */
  async createCheckout(userId: string, packageId: string): Promise<{ url: string }> {
    this.assertConfigured();
    const rcUserId = await this.getRcUserId(userId);

    const res = await fetch(`${RC_V2}/projects/${this.projectId}/checkout_sessions`, {
      method:  'POST',
      headers: this.headers,
      body: JSON.stringify({
        app_user_id: rcUserId,
        package_id:  packageId,
        success_url: `${this.appUrl}/subscribe?checkout=success`,
        cancel_url:  `${this.appUrl}/subscribe`,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`RC createCheckout → ${res.status}: ${body}`);
      throw new Error('Failed to start checkout. Please try again.');
    }

    const result: any = await res.json();
    const url = result?.url ?? result?.checkout_url;
    if (!url) throw new Error('No checkout URL returned from RevenueCat.');
    return { url };
  }

  /**
   * Billing portal URL.
   * RC has no dedicated portal endpoint — management_url in the v1 subscriber
   * response is the correct URL (RC Billing portal for web subs, App Store /
   * Play Store link for mobile subs).
   */
  async getPortalUrl(userId: string): Promise<{ url: string }> {
    this.assertConfigured();
    const rcUserId   = await this.getRcUserId(userId);
    const subscriber = await this.getSubscriberV1(rcUserId);
    const url        = subscriber?.management_url as string | undefined;

    if (!url) {
      throw new Error('No billing portal available. You may not have an active subscription.');
    }

    return { url };
  }

  /**
   * Cancel the active subscription via RC v2.
   * Finds active subscription key from v1, then cancels via v2.
   * Access continues until period end — RC webhook handles isPro revocation.
   */
  async cancelSubscription(userId: string): Promise<{ ok: boolean }> {
    this.assertConfigured();
    const rcUserId   = await this.getRcUserId(userId);
    const subscriber = await this.getSubscriberV1(rcUserId);

    const subs: Record<string, any> = subscriber?.subscriptions ?? {};
    const activeKey = Object.keys(subs).find(k => {
      const s = subs[k];
      return !s.unsubscribe_detected_at
        && (!s.expires_date || new Date(s.expires_date) > new Date());
    });

    if (!activeKey) return { ok: true }; // nothing active

    const res = await fetch(
      `${RC_V2}/projects/${this.projectId}/customers/${encodeURIComponent(rcUserId)}/subscriptions/${encodeURIComponent(activeKey)}/cancel`,
      { method: 'POST', headers: this.headers },
    );

    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`RC cancel → ${res.status}: ${body}`);
      throw new Error('Failed to cancel. Please try again or contact support.');
    }

    this.logger.log(`Cancelled: userId=${userId} key=${activeKey}`);
    return { ok: true };
  }

  // ── Utils ──────────────────────────────────────────────────────────────────

  private _normalisePeriod(raw: string): string {
    if (!raw) return 'month';
    const r = raw.toUpperCase();
    if (r.includes('ANNUAL') || r.includes('YEARLY') || r.includes('P1Y') || r === '$RC_ANNUAL') return 'year';
    if (r.includes('WEEKLY') || r.includes('P1W')    || r === '$RC_WEEKLY')  return 'week';
    if (r.includes('DAILY')  || r.includes('P1D')    || r === '$RC_DAILY')   return 'day';
    return 'month';
  }
}
