import { closingLineValue } from './clv.js';
import { buildSportsConsensus } from './consensus.js';
import { removeVigPower } from './odds.js';
import { SportsPaperLedger } from './paper-ledger.js';
import {
  researchProvenanceAllowed,
  sportsProviderPolicy,
  type SportsDataProvenance,
  type SportsProviderId,
} from './provider-policy.js';
import type { OutcomeOdds, SportsMarketKind, VenueFairMarket } from './types.js';

export type SportsSnapshotStage = 'OPEN' | 'CLOSE' | 'SETTLED';
export type SportsCommissionModel = 'NET_MARKET_WINNINGS' | 'PER_BET_WIN_LOSS';

export interface SportsVenueSnapshot {
  provider: SportsProviderId;
  venue: string;
  /** Canonical cross-venue event id supplied by the ingestion/normalization layer. */
  eventId: string;
  /** Canonical cross-venue market id supplied by the ingestion/normalization layer. */
  marketId: string;
  marketKind: SportsMarketKind;
  line?: number;
  /** Provider/source timestamp for provenance/debugging. Causality never relies on this field. */
  asOfMs: number;
  /** Local receive/observation timestamp. Required for causal OPEN/CLOSE/SETTLED research. */
  receivedAtMs?: number;
  /** Optional source timestamp if the upstream schema exposes a second clock. */
  sourceTsMs?: number;
  /** Optional event start. When present, OPEN snapshots at/after start are rejected in V1.5 pre-match mode. */
  eventStartMs?: number;
  stage?: SportsSnapshotStage;
  quotes: OutcomeOdds[];
  /** Required for Betfair/Smarkets paper candidates; must reflect the account/data contract being modeled. */
  commissionRate?: number;
  /** Betfair and Smarkets Standard usually settle on net market winnings; some Smarkets tiers charge per matched bet on wins/losses. */
  commissionModel?: SportsCommissionModel;
  /** Optional manual confidence weight for consensus only. */
  weight?: number;
  /** Required to produce research candidates; UNKNOWN/missing data is fail-closed. */
  provenance?: SportsDataProvenance;
  sourceEventId?: string;
  sourceMarketId?: string;
  /** Required for LICENSED_FEED / EXPLICIT_RESEARCH_LICENSE so audit output can trace the rights contract. */
  sourceContractId?: string;
  /** Set only on SETTLED rows. Use VOID when the market itself is void. */
  settledOutcome?: string;
}

export interface SportsResearchConfig {
  maxAgeMs: number;
  minConsensusVenues: number;
  minEdge: number;
  minStakeUsd: number;
  maxStakeUsd: number;
  bankrollUsd: number;
  stakePct: number;
  maxOpenRiskPct: number;
  /** Close snapshots later than eventStart + this grace are excluded when eventStart is known. */
  closeGraceMs: number;
}

export interface SportsPaperCandidate {
  id: string;
  provider: SportsProviderId;
  venue: string;
  eventId: string;
  marketId: string;
  marketKind: SportsMarketKind;
  line?: number;
  outcome: string;
  quotedDecimalOdds: number;
  effectiveDecimalOdds: number;
  commissionRate: number;
  commissionModel: SportsCommissionModel;
  winProfitMultiplier: number;
  lossMultiplier: number;
  fairProbability: number;
  rawExpectedValue: number;
  netExpectedValue: number;
  consensusVenues: string[];
  consensusSources: Array<{ venue: string; provider: SportsProviderId; provenance: SportsDataProvenance; sourceContractId?: string }>;
  consensusDispersion: number;
  sourceEventId?: string;
  sourceMarketId?: string;
  sourceContractId?: string;
  asOfMs: number;
  stakeUsd: number;
  provenance: SportsDataProvenance;
  closeClvPct?: number;
  closeLogClv?: number;
  settlement?: 'WON' | 'LOST' | 'VOID';
  settlementProvenance?: SportsDataProvenance;
  settledAtMs?: number;
  pnlUsd?: number;
}

export interface SportsResearchReport {
  mode: 'SPORTS_RESEARCH_PAPER_ONLY';
  liveBettingEnabled: false;
  executionEvidence: 'PRICE_ONLY_NOT_FILL_PROOF';
  selectionPolicy: 'CAUSAL_FIRST_QUALIFYING_ONE_POSITION_PER_VENUE_MARKET';
  snapshots: number;
  openSnapshots: number;
  qualifyingSignals: number;
  candidateCount: number;
  settledCandidates: number;
  uniqueSettledEvents: number;
  uniqueSettledMarkets: number;
  wins: number;
  losses: number;
  voids: number;
  realizedPnlUsd: number;
  turnoverUsd: number;
  roi: number;
  endingBankrollUsd: number;
  maxDrawdownPct: number;
  meanNetEvAtEntry: number;
  medianNetEvAtEntry: number;
  meanClvPct?: number;
  positiveClvRate?: number;
  clvCoveragePct: number;
  clvLower95Pct?: number;
  meanEventRoi?: number;
  eventRoiLower95?: number;
  maxEventTurnoverConcentrationPct: number;
  maxEventPnlConcentrationPct: number;
  candidates: SportsPaperCandidate[];
  blockers: string[];
}

const DEFAULT_CONFIG: SportsResearchConfig = {
  maxAgeMs: 5 * 60_000,
  minConsensusVenues: 2,
  minEdge: 0.02,
  minStakeUsd: 1,
  maxStakeUsd: 5,
  bankrollUsd: 100,
  stakePct: 0.02,
  maxOpenRiskPct: 0.1,
  closeGraceMs: 0,
};

function assertCommission(value: number | undefined, model: SportsCommissionModel | undefined): { rate: number; model: SportsCommissionModel } {
  if (value === undefined || model === undefined) throw new Error('SPORTS_COMMISSION_UNKNOWN');
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('SPORTS_INVALID_COMMISSION_RATE');
  if (model !== 'NET_MARKET_WINNINGS' && model !== 'PER_BET_WIN_LOSS') throw new Error('SPORTS_INVALID_COMMISSION_MODEL');
  return { rate: value, model };
}

export function commissionSettlementMultipliers(decimalOdds: number, commissionRate: number, model: SportsCommissionModel): { winProfitMultiplier: number; lossMultiplier: number; effectiveDecimalOdds: number } {
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) throw new Error('SPORTS_INVALID_DECIMAL_ODDS');
  if (!Number.isFinite(commissionRate) || commissionRate < 0 || commissionRate >= 1) throw new Error('SPORTS_INVALID_COMMISSION_RATE');
  const winProfitMultiplier = (decimalOdds - 1) * (1 - commissionRate);
  const lossMultiplier = model === 'PER_BET_WIN_LOSS' ? 1 + commissionRate : 1;
  return { winProfitMultiplier, lossMultiplier, effectiveDecimalOdds: 1 + winProfitMultiplier };
}

export function effectiveDecimalOddsAfterCommission(decimalOdds: number, commissionRate = 0): number {
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) throw new Error('SPORTS_INVALID_DECIMAL_ODDS');
  if (!Number.isFinite(commissionRate) || commissionRate < 0 || commissionRate >= 1) throw new Error('SPORTS_INVALID_COMMISSION_RATE');
  return 1 + (decimalOdds - 1) * (1 - commissionRate);
}

function lineKey(line: number | undefined): string {
  return line === undefined ? '' : Number(line.toFixed(6)).toString();
}

function keyOf(row: Pick<SportsVenueSnapshot, 'eventId' | 'marketId' | 'marketKind' | 'line'>): string {
  return `${row.eventId}\u0000${row.marketId}\u0000${row.marketKind}\u0000${lineKey(row.line)}`;
}

function positionKey(row: Pick<SportsVenueSnapshot, 'eventId' | 'marketId' | 'marketKind' | 'line' | 'venue'>): string {
  return `${keyOf(row)}\u0000${row.venue}`;
}

function researchClock(row: SportsVenueSnapshot): number {
  if (!Number.isFinite(row.receivedAtMs)) throw new Error('SPORTS_RECEIVED_TIME_UNKNOWN');
  return row.receivedAtMs as number;
}

function hasResearchClock(row: SportsVenueSnapshot): boolean {
  return Number.isFinite(row.receivedAtMs) && (row.receivedAtMs as number) >= 0;
}

function sameCanonicalEventStart(row: SportsVenueSnapshot, expectedEventStartMs: number): boolean {
  return Number.isFinite(row.eventStartMs) && row.eventStartMs === expectedEventStartMs;
}

function fairMarket(row: SportsVenueSnapshot): VenueFairMarket {
  return {
    venue: row.venue,
    eventId: row.eventId,
    marketId: row.marketId,
    marketKind: row.marketKind,
    line: row.line,
    asOfMs: researchClock(row),
    outcomes: removeVigPower(row.quotes),
    weight: row.weight,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function lower95(values: number[]): number | undefined {
  if (values.length < 2) return undefined;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const se = Math.sqrt(Math.max(0, variance)) / Math.sqrt(values.length);
  return mean - 1.96 * se;
}

function latestByVenue(rows: SportsVenueSnapshot[]): SportsVenueSnapshot[] {
  const latest = new Map<string, SportsVenueSnapshot>();
  for (const row of rows) {
    if (!hasResearchClock(row)) continue;
    const previous = latest.get(row.venue);
    if (!previous || researchClock(row) > researchClock(previous)) latest.set(row.venue, row);
  }
  return [...latest.values()];
}

function settlementInfo(
  rows: SportsVenueSnapshot[],
  outcome: string,
  minSettledAtMs: number,
  expectedEventStartMs: number,
): { result?: 'WON' | 'LOST' | 'VOID'; settledAtMs?: number; conflict?: boolean; provenance?: SportsDataProvenance } {
  const eligible = rows
    .filter((row) =>
      (row.stage ?? 'OPEN') === 'SETTLED' &&
      row.settledOutcome &&
      hasResearchClock(row) &&
      researchClock(row) >= minSettledAtMs &&
      sameCanonicalEventStart(row, expectedEventStartMs) &&
      validResearchRow(row),
    )
    .sort((a, b) => researchClock(a) - researchClock(b));
  const outcomes = new Set(eligible.map((row) => row.settledOutcome));
  if (outcomes.size > 1) return { conflict: true };
  const settled = eligible[0];
  if (!settled?.settledOutcome) return {};
  const settledAtMs = researchClock(settled);
  if (settled.settledOutcome === 'VOID') return { result: 'VOID', settledAtMs, provenance: settled.provenance };
  return { result: settled.settledOutcome === outcome ? 'WON' : 'LOST', settledAtMs, provenance: settled.provenance };
}

function validResearchRow(row: SportsVenueSnapshot): boolean {
  if (!researchProvenanceAllowed(row.provider, row.provenance)) return false;
  if (row.provenance === 'LICENSED_FEED' || row.provenance === 'EXPLICIT_RESEARCH_LICENSE') {
    return Boolean(row.sourceContractId?.trim());
  }
  return true;
}

function closeReferences(rows: SportsVenueSnapshot[], target: SportsVenueSnapshot, config: SportsResearchConfig): SportsVenueSnapshot[] {
  if (target.eventStartMs === undefined || !Number.isFinite(target.eventStartMs)) return [];
  const minClose = Math.max(researchClock(target), target.eventStartMs - config.maxAgeMs);
  const maxClose = target.eventStartMs + config.closeGraceMs;
  return latestByVenue(rows.filter((row) =>
    (row.stage ?? 'OPEN') === 'CLOSE' &&
    row.venue !== target.venue &&
    hasResearchClock(row) &&
    sameCanonicalEventStart(row, target.eventStartMs as number) &&
    researchClock(row) >= minClose &&
    researchClock(row) <= maxClose &&
    validResearchRow(row),
  ));
}

interface CandidateProposal extends SportsPaperCandidate {
  stakeUsd: 0;
}

export function runSportsResearch(
  snapshots: SportsVenueSnapshot[],
  configPatch: Partial<SportsResearchConfig> = {},
): SportsResearchReport {
  const config = { ...DEFAULT_CONFIG, ...configPatch };
  if (!Number.isInteger(config.minConsensusVenues) || config.minConsensusVenues < 1) throw new Error('SPORTS_INVALID_MIN_CONSENSUS_VENUES');
  if (!(config.minEdge >= 0 && Number.isFinite(config.minEdge))) throw new Error('SPORTS_INVALID_MIN_EDGE');
  if (!(config.bankrollUsd > 0 && config.stakePct > 0 && config.maxStakeUsd >= config.minStakeUsd && config.minStakeUsd > 0)) {
    throw new Error('SPORTS_INVALID_STAKING_CONFIG');
  }
  if (!(config.maxOpenRiskPct > 0 && config.maxOpenRiskPct <= 1)) throw new Error('SPORTS_INVALID_OPEN_RISK_LIMIT');
  if (!(config.maxAgeMs > 0 && config.closeGraceMs >= 0)) throw new Error('SPORTS_INVALID_TIME_CONFIG');

  const grouped = new Map<string, SportsVenueSnapshot[]>();
  const blockers = new Set<string>();
  for (const snapshot of snapshots) {
    if (!snapshot.eventId || !snapshot.marketId || !snapshot.venue) throw new Error('SPORTS_INVALID_SNAPSHOT_IDENTITY');
    if (!Number.isFinite(snapshot.asOfMs) || snapshot.asOfMs < 0) throw new Error('SPORTS_INVALID_SNAPSHOT_TIME');
    if (!hasResearchClock(snapshot)) blockers.add('RECEIVED_TIME_UNKNOWN');
    if (!validResearchRow(snapshot)) blockers.add('UNVERIFIED_DATA_PROVENANCE');
    const key = keyOf(snapshot);
    const bucket = grouped.get(key) ?? [];
    bucket.push(snapshot);
    grouped.set(key, bucket);
  }

  const proposals: CandidateProposal[] = [];
  const selectedPositions = new Set<string>();
  let qualifyingSignals = 0;

  for (const rows of grouped.values()) {
    const openRows = rows
      .filter((row) => (row.stage ?? 'OPEN') === 'OPEN')
      .sort((a, b) => (hasResearchClock(a) && hasResearchClock(b) ? researchClock(a) - researchClock(b) : a.asOfMs - b.asOfMs) || a.venue.localeCompare(b.venue));

    for (const target of openRows) {
      const policy = sportsProviderPolicy(target.provider);
      if (policy.role !== 'RESEARCH_PAPER_CANDIDATE') continue;
      if (!validResearchRow(target)) continue;
      if (!hasResearchClock(target)) continue;
      if (target.eventStartMs === undefined || !Number.isFinite(target.eventStartMs)) {
        blockers.add('EVENT_START_UNKNOWN');
        continue;
      }
      if (researchClock(target) >= target.eventStartMs) {
        blockers.add('INPLAY_OR_POSTSTART_SNAPSHOT_REJECTED');
        continue;
      }
      const posKey = positionKey(target);
      if (selectedPositions.has(posKey)) continue;

      // Causal leave-one-venue-out consensus: only the latest snapshot from each
      // independent venue that was already observable at target received-time is eligible.
      const refs = latestByVenue(openRows.filter((row) =>
        row.venue !== target.venue &&
        hasResearchClock(row) &&
        sameCanonicalEventStart(row, target.eventStartMs as number) &&
        researchClock(row) <= researchClock(target) &&
        researchClock(target) - researchClock(row) <= config.maxAgeMs &&
        validResearchRow(row),
      ));
      if (new Set(refs.map((row) => row.venue)).size < config.minConsensusVenues) {
        blockers.add('INSUFFICIENT_INDEPENDENT_CONSENSUS');
        continue;
      }
      if (refs.some((row) => row.provenance === 'MANUAL_RESEARCH')) blockers.add('MANUAL_REFERENCE_DATA');

      let consensus;
      try {
        consensus = buildSportsConsensus(refs.map(fairMarket), config.maxAgeMs);
      } catch {
        blockers.add('CONSENSUS_BUILD_FAILED');
        continue;
      }

      let commission: { rate: number; model: SportsCommissionModel };
      try {
        commission = assertCommission(target.commissionRate, target.commissionModel);
      } catch {
        blockers.add('COMMISSION_UNKNOWN');
        continue;
      }

      const eligible = target.quotes.flatMap((quote) => {
        const fair = consensus.outcomes.find((outcome) => outcome.outcome === quote.outcome);
        if (!fair || fair.contributors < config.minConsensusVenues) return [];
        const multipliers = commissionSettlementMultipliers(quote.decimalOdds, commission.rate, commission.model);
        const rawExpectedValue = quote.decimalOdds * fair.fairProbability - 1;
        const netExpectedValue = fair.fairProbability * multipliers.winProfitMultiplier - (1 - fair.fairProbability) * multipliers.lossMultiplier;
        if (netExpectedValue < config.minEdge) return [];
        return [{ quote, fair, ...multipliers, rawExpectedValue, netExpectedValue }];
      }).sort((a, b) => b.netExpectedValue - a.netExpectedValue || a.quote.outcome.localeCompare(b.quote.outcome));

      if (eligible.length === 0) continue;
      qualifyingSignals += eligible.length;
      const best = eligible[0];
      if (!best) continue;

      const provenance = target.provenance ?? 'UNKNOWN';
      const candidate: CandidateProposal = {
        id: `${target.eventId}:${target.marketId}:${target.marketKind}:${target.venue}:${lineKey(target.line)}`,
        provider: target.provider,
        venue: target.venue,
        eventId: target.eventId,
        marketId: target.marketId,
        marketKind: target.marketKind,
        line: target.line,
        outcome: best.quote.outcome,
        quotedDecimalOdds: best.quote.decimalOdds,
        effectiveDecimalOdds: best.effectiveDecimalOdds,
        commissionRate: commission.rate,
        commissionModel: commission.model,
        winProfitMultiplier: best.winProfitMultiplier,
        lossMultiplier: best.lossMultiplier,
        fairProbability: best.fair.fairProbability,
        rawExpectedValue: best.rawExpectedValue,
        netExpectedValue: best.netExpectedValue,
        consensusVenues: consensus.sourceVenues,
        consensusSources: refs.map((row) => ({
          venue: row.venue,
          provider: row.provider,
          provenance: row.provenance ?? 'UNKNOWN',
          ...(row.sourceContractId ? { sourceContractId: row.sourceContractId } : {}),
        })),
        consensusDispersion: best.fair.dispersion,
        sourceEventId: target.sourceEventId,
        sourceMarketId: target.sourceMarketId,
        sourceContractId: target.sourceContractId,
        asOfMs: researchClock(target),
        stakeUsd: 0,
        provenance,
      };

      const closeRefs = closeReferences(rows, target, config);
      if (closeRefs.some((row) => row.provenance === 'MANUAL_RESEARCH')) blockers.add('MANUAL_REFERENCE_DATA');
      if (new Set(closeRefs.map((row) => row.venue)).size >= config.minConsensusVenues) {
        try {
          const closeConsensus = buildSportsConsensus(closeRefs.map(fairMarket), config.maxAgeMs);
          const closeFair = closeConsensus.outcomes.find((outcome) => outcome.outcome === best.quote.outcome);
          if (closeFair) {
            // CLV measures price movement; commission is reported separately and must not distort the closing price comparison.
            const clv = closingLineValue(best.quote.decimalOdds, closeFair.fairProbability);
            candidate.closeClvPct = clv.clvPct;
            candidate.closeLogClv = clv.logClv;
          }
        } catch {
          blockers.add('CLOSING_CONSENSUS_BUILD_FAILED');
        }
      }

      const settlement = settlementInfo(rows, candidate.outcome, Math.max(researchClock(target), target.eventStartMs), target.eventStartMs);
      if (settlement.conflict) blockers.add('CONFLICTING_SETTLEMENT');
      if (settlement.result && settlement.provenance === 'MANUAL_RESEARCH') blockers.add('MANUAL_SETTLEMENT_DATA');
      candidate.settlement = settlement.result;
      candidate.settlementProvenance = settlement.provenance;
      candidate.settledAtMs = settlement.settledAtMs;
      proposals.push(candidate);
      selectedPositions.add(posKey);
    }
  }

  proposals.sort((a, b) => a.asOfMs - b.asOfMs || a.id.localeCompare(b.id));
  const ledger = new SportsPaperLedger(config.bankrollUsd, config.maxOpenRiskPct);
  const candidates: SportsPaperCandidate[] = [];
  const unsettled = new Map<string, SportsPaperCandidate>();

  const settleDue = (clockMs: number): void => {
    for (const candidate of [...unsettled.values()]) {
      if (!candidate.settlement || candidate.settledAtMs === undefined || candidate.settledAtMs > clockMs) continue;
      const settled = ledger.settle(candidate.id, candidate.settlement, candidate.settledAtMs);
      candidate.pnlUsd = settled.pnlUsd;
      unsettled.delete(candidate.id);
    }
  };

  for (const proposal of proposals) {
    settleDue(proposal.asOfMs);
    const before = ledger.snapshot();
    const stakeUsd = Math.min(config.maxStakeUsd, Math.max(config.minStakeUsd, before.bankrollUsd * config.stakePct));
    if (stakeUsd > before.bankrollUsd + 1e-9) {
      blockers.add('PAPER_BANKROLL_EXHAUSTED');
      continue;
    }
    try {
      ledger.place({
        id: proposal.id,
        eventId: proposal.eventId,
        marketId: proposal.marketId,
        outcome: proposal.outcome,
        venue: proposal.venue,
        decimalOdds: proposal.quotedDecimalOdds,
        fairProbabilityAtEntry: proposal.fairProbability,
        winProfitMultiplier: proposal.winProfitMultiplier,
        lossMultiplier: proposal.lossMultiplier,
        stakeUsd,
        placedAtMs: proposal.asOfMs,
      }, config.minEdge);
    } catch (error) {
      if (error instanceof Error && error.message === 'SPORTS_OPEN_RISK_LIMIT') blockers.add('PAPER_OPEN_RISK_LIMIT');
      else throw error;
      continue;
    }
    const placed: SportsPaperCandidate = { ...proposal, stakeUsd };
    candidates.push(placed);
    unsettled.set(placed.id, placed);
  }
  settleDue(Number.POSITIVE_INFINITY);

  const settled = candidates.filter((candidate) => candidate.settlement && candidate.pnlUsd !== undefined);
  const wins = settled.filter((candidate) => candidate.settlement === 'WON').length;
  const losses = settled.filter((candidate) => candidate.settlement === 'LOST').length;
  const voids = settled.filter((candidate) => candidate.settlement === 'VOID').length;
  const realizedPnlUsd = settled.reduce((sum, candidate) => sum + (candidate.pnlUsd ?? 0), 0);
  const turnoverUsd = settled.reduce((sum, candidate) => sum + candidate.stakeUsd, 0);
  const clvs = settled.flatMap((candidate) => candidate.closeClvPct === undefined ? [] : [candidate.closeClvPct]);
  const evs = candidates.map((candidate) => candidate.netExpectedValue);

  const eventStats = new Map<string, { pnl: number; turnover: number; clvs: number[]; markets: Set<string> }>();
  for (const candidate of settled) {
    const row = eventStats.get(candidate.eventId) ?? { pnl: 0, turnover: 0, clvs: [], markets: new Set<string>() };
    row.pnl += candidate.pnlUsd ?? 0;
    row.turnover += candidate.stakeUsd;
    if (candidate.closeClvPct !== undefined) row.clvs.push(candidate.closeClvPct);
    row.markets.add(candidate.marketId);
    eventStats.set(candidate.eventId, row);
  }
  const eventValues = [...eventStats.values()];
  const eventRois = eventValues.filter((row) => row.turnover > 0).map((row) => row.pnl / row.turnover);
  const eventClvs = eventValues.flatMap((row) => row.clvs.length ? [row.clvs.reduce((sum, value) => sum + value, 0) / row.clvs.length] : []);
  const maxEventTurnover = Math.max(0, ...eventValues.map((row) => row.turnover));
  const absoluteEventPnl = eventValues.reduce((sum, row) => sum + Math.abs(row.pnl), 0);
  const maxEventAbsPnl = Math.max(0, ...eventValues.map((row) => Math.abs(row.pnl)));
  const ledgerSnapshot = ledger.snapshot();

  if (candidates.length === 0) blockers.add('NO_PAPER_CANDIDATES');
  if (settled.length === 0) blockers.add('NO_SETTLED_PAPER_EVIDENCE');
  if (clvs.length === 0) blockers.add('NO_CLOSING_LINE_EVIDENCE');

  return {
    mode: 'SPORTS_RESEARCH_PAPER_ONLY',
    liveBettingEnabled: false,
    executionEvidence: 'PRICE_ONLY_NOT_FILL_PROOF',
    selectionPolicy: 'CAUSAL_FIRST_QUALIFYING_ONE_POSITION_PER_VENUE_MARKET',
    snapshots: snapshots.length,
    openSnapshots: snapshots.filter((row) => (row.stage ?? 'OPEN') === 'OPEN').length,
    qualifyingSignals,
    candidateCount: candidates.length,
    settledCandidates: settled.length,
    uniqueSettledEvents: eventStats.size,
    uniqueSettledMarkets: new Set(settled.map((candidate) => `${candidate.eventId}\u0000${candidate.marketId}`)).size,
    wins,
    losses,
    voids,
    realizedPnlUsd,
    turnoverUsd,
    roi: turnoverUsd > 0 ? realizedPnlUsd / turnoverUsd : 0,
    endingBankrollUsd: ledgerSnapshot.bankrollUsd,
    maxDrawdownPct: ledgerSnapshot.maxDrawdownPct,
    meanNetEvAtEntry: evs.length ? evs.reduce((sum, value) => sum + value, 0) / evs.length : 0,
    medianNetEvAtEntry: median(evs),
    meanClvPct: clvs.length ? clvs.reduce((sum, value) => sum + value, 0) / clvs.length : undefined,
    positiveClvRate: clvs.length ? clvs.filter((value) => value > 0).length / clvs.length : undefined,
    clvCoveragePct: settled.length ? clvs.length / settled.length : 0,
    clvLower95Pct: lower95(eventClvs),
    meanEventRoi: eventRois.length ? eventRois.reduce((sum, value) => sum + value, 0) / eventRois.length : undefined,
    eventRoiLower95: lower95(eventRois),
    maxEventTurnoverConcentrationPct: turnoverUsd > 0 ? maxEventTurnover / turnoverUsd : 0,
    maxEventPnlConcentrationPct: absoluteEventPnl > 0 ? maxEventAbsPnl / absoluteEventPnl : 0,
    candidates,
    blockers: [...blockers].sort(),
  };
}
