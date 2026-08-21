export interface PaperBetRequest {
  id: string;
  eventId: string;
  marketId: string;
  outcome: string;
  venue: string;
  decimalOdds: number;
  fairProbabilityAtEntry: number;
  stakeUsd: number;
  placedAtMs: number;
  /** Net profit per $1 stake when the bet wins, after modeled commission. Defaults to decimalOdds-1. */
  winProfitMultiplier?: number;
  /** Loss per $1 stake when the bet loses, after modeled commission. Defaults to 1. */
  lossMultiplier?: number;
}

export interface PaperBet extends PaperBetRequest {
  edgeAtEntry: number;
  status: 'OPEN' | 'WON' | 'LOST' | 'VOID';
  pnlUsd?: number;
  settledAtMs?: number;
}

export interface PaperLedgerSnapshot {
  initialBankrollUsd: number;
  bankrollUsd: number;
  peakBankrollUsd: number;
  maxDrawdownPct: number;
  openRiskUsd: number;
  settledBets: number;
  realizedPnlUsd: number;
}

export class SportsPaperLedger {
  private readonly bets = new Map<string, PaperBet>();
  private bankrollUsd: number;
  private peakBankrollUsd: number;
  private maxDrawdownPct = 0;
  private realizedPnlUsd = 0;

  constructor(readonly initialBankrollUsd: number, readonly maxOpenRiskPct = 0.1) {
    if (!Number.isFinite(initialBankrollUsd) || initialBankrollUsd <= 0) throw new Error('SPORTS_INVALID_INITIAL_BANKROLL');
    if (!Number.isFinite(maxOpenRiskPct) || maxOpenRiskPct <= 0 || maxOpenRiskPct > 1) throw new Error('SPORTS_INVALID_OPEN_RISK_LIMIT');
    this.bankrollUsd = initialBankrollUsd;
    this.peakBankrollUsd = initialBankrollUsd;
  }

  place(request: PaperBetRequest, minEdge = 0): PaperBet {
    if (this.bets.has(request.id)) throw new Error(`SPORTS_DUPLICATE_PAPER_BET:${request.id}`);
    if (!Number.isFinite(request.decimalOdds) || request.decimalOdds <= 1) throw new Error('SPORTS_INVALID_DECIMAL_ODDS');
    if (!Number.isFinite(request.fairProbabilityAtEntry) || request.fairProbabilityAtEntry <= 0 || request.fairProbabilityAtEntry >= 1) {
      throw new Error('SPORTS_INVALID_FAIR_PROBABILITY');
    }
    if (!Number.isFinite(request.stakeUsd) || request.stakeUsd <= 0) throw new Error('SPORTS_INVALID_STAKE');
    const winProfitMultiplier = request.winProfitMultiplier ?? request.decimalOdds - 1;
    const lossMultiplier = request.lossMultiplier ?? 1;
    if (!Number.isFinite(winProfitMultiplier) || winProfitMultiplier < 0 || !Number.isFinite(lossMultiplier) || lossMultiplier <= 0) {
      throw new Error('SPORTS_INVALID_SETTLEMENT_MULTIPLIER');
    }
    const edgeAtEntry = request.fairProbabilityAtEntry * winProfitMultiplier - (1 - request.fairProbabilityAtEntry) * lossMultiplier;
    if (edgeAtEntry < minEdge) throw new Error('SPORTS_EDGE_BELOW_THRESHOLD');
    // Open risk is modeled as worst-case losing liability, not raw stake.
    const requestedRisk = request.stakeUsd * lossMultiplier;
    if (this.openRiskUsd() + requestedRisk > this.bankrollUsd * this.maxOpenRiskPct + 1e-9) {
      throw new Error('SPORTS_OPEN_RISK_LIMIT');
    }
    const bet: PaperBet = { ...request, winProfitMultiplier, lossMultiplier, edgeAtEntry, status: 'OPEN' };
    this.bets.set(request.id, bet);
    return { ...bet };
  }

  settle(id: string, result: 'WON' | 'LOST' | 'VOID', settledAtMs: number): PaperBet {
    const current = this.bets.get(id);
    if (!current) throw new Error(`SPORTS_UNKNOWN_PAPER_BET:${id}`);
    if (current.status !== 'OPEN') throw new Error(`SPORTS_PAPER_BET_ALREADY_SETTLED:${id}`);
    const winProfitMultiplier = current.winProfitMultiplier ?? current.decimalOdds - 1;
    const lossMultiplier = current.lossMultiplier ?? 1;
    const pnlUsd = result === 'WON' ? current.stakeUsd * winProfitMultiplier : result === 'LOST' ? -current.stakeUsd * lossMultiplier : 0;
    const settled: PaperBet = { ...current, status: result, pnlUsd, settledAtMs };
    this.bets.set(id, settled);
    this.bankrollUsd += pnlUsd;
    this.realizedPnlUsd += pnlUsd;
    this.peakBankrollUsd = Math.max(this.peakBankrollUsd, this.bankrollUsd);
    const drawdown = this.peakBankrollUsd > 0 ? (this.peakBankrollUsd - this.bankrollUsd) / this.peakBankrollUsd : 1;
    this.maxDrawdownPct = Math.max(this.maxDrawdownPct, drawdown);
    return { ...settled };
  }

  list(): PaperBet[] {
    return [...this.bets.values()].map((bet) => ({ ...bet }));
  }

  snapshot(): PaperLedgerSnapshot {
    return {
      initialBankrollUsd: this.initialBankrollUsd,
      bankrollUsd: this.bankrollUsd,
      peakBankrollUsd: this.peakBankrollUsd,
      maxDrawdownPct: this.maxDrawdownPct,
      openRiskUsd: this.openRiskUsd(),
      settledBets: [...this.bets.values()].filter((bet) => bet.status !== 'OPEN').length,
      realizedPnlUsd: this.realizedPnlUsd,
    };
  }

  private openRiskUsd(): number {
    return [...this.bets.values()].reduce((sum, bet) => sum + (bet.status === 'OPEN' ? bet.stakeUsd * (bet.lossMultiplier ?? 1) : 0), 0);
  }
}
