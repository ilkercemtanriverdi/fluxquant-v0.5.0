export const RESEARCH_MARKETS = ['crypto', 'football', 'polymarket'] as const;
export type ResearchMarket = (typeof RESEARCH_MARKETS)[number];

export const RESEARCH_STATUSES = ['KEEP', 'KILL', 'PROMOTE', 'BLOCKED'] as const;
export type ResearchStatus = (typeof RESEARCH_STATUSES)[number];

export const RESEARCH_MODES = ['research', 'shadow', 'paper'] as const;
export type ResearchMode = (typeof RESEARCH_MODES)[number];

export interface ResearchEvidence {
  kind: string;
  summary: string;
}

export interface ResearchImplementation {
  kind: 'existing_module' | 'historical_runner' | 'external_reference';
  module?: string;
}

export interface ResearchStrategyRecord {
  id: string;
  market: ResearchMarket;
  status: ResearchStatus;
  mode: ResearchMode;
  hypothesis: string;
  implementation: ResearchImplementation;
  evidence: ResearchEvidence[];
  blockers: string[];
  nextTest: string | null;
  realMoneyEligible: boolean;
}

export interface ResearchRegistry {
  schemaVersion: 1;
  checkpointDate: string;
  mission: string;
  governance: {
    userQuestionIsNotPivot: true;
    silentPivotForbidden: true;
    reuseFirstInventSecond: true;
    shortestCrediblePath: true;
    realMoneyGate: 'NO_GO';
    productionVersion: '1.5.0';
  };
  strategies: ResearchStrategyRecord[];
}
