import { EndpointError } from 'sdk';
import { calculateRunway } from '../lib/runway.js';

export interface FastStateResponse {
  queued: number;
  totalEur: number;
  balances: Array<{
    account: string;
    currency: string;
    balance: number;
    balanceEur: number;
  }>;
  fromCache?: boolean;
}

export default async function (
  input: { userId?: number } | undefined,
  ctx?: { initData?: { user?: { id?: number } } },
): Promise<FastStateResponse> {
  const userId = ctx?.initData?.user?.id ?? input?.userId;
  if (!userId) {
    throw new EndpointError('Unauthorized', { code: 'UNAUTHORIZED' });
  }

  const runway = await calculateRunway(userId);
  const balances = runway.accounts.map((a) => ({
    account: `${a.name} · ${a.currency}`,
    currency: a.currency,
    balance: a.balanceCents / 100,
    balanceEur: a.balanceEurCents / 100,
  }));

  return {
    queued: 0,
    totalEur: Math.round(runway.totalLiquidCents / 100 * 100) / 100,
    balances,
    fromCache: false,
  };
}
