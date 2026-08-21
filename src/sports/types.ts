export type SportsMarketKind = '1x2' | 'moneyline' | 'spread' | 'total' | 'other';

export interface OutcomeOdds {
  outcome: string;
  decimalOdds: number;
}

export interface FairOutcomeProbability {
  outcome: string;
  probability: number;
}

export interface VenueFairMarket {
  venue: string;
  eventId: string;
  marketId: string;
  marketKind: SportsMarketKind;
  line?: number;
  asOfMs: number;
  outcomes: FairOutcomeProbability[];
  weight?: number;
}

export interface ConsensusOutcome {
  outcome: string;
  fairProbability: number;
  fairDecimalOdds: number;
  contributors: number;
  dispersion: number;
}

export interface SportsConsensus {
  eventId: string;
  marketId: string;
  marketKind: SportsMarketKind;
  line?: number;
  asOfMs: number;
  outcomes: ConsensusOutcome[];
  sourceVenues: string[];
}
