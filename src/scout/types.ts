export type ScoutChain = 'solana' | 'base' | 'ethereum' | 'arbitrum' | 'bsc' | string;
export type ScoutSource = 'geckoterminal' | 'birdeye' | 'dexscreener';
export type ScoutStatus = 'REJECT' | 'WATCH' | 'HIGH_INTEREST' | 'SECURITY_PENDING';

export interface TimeBucketActivity {
  buys?: number;
  sells?: number;
  buyers?: number;
  sellers?: number;
  volumeUsd?: number;
  priceChangePct?: number;
}

export interface EmergingAssetCandidate {
  source: ScoutSource;
  chain: ScoutChain;
  tokenAddress: string;
  tokenName?: string;
  tokenSymbol?: string;
  pairAddress?: string;
  dexId?: string;
  quoteTokenAddress?: string;
  quoteTokenSymbol?: string;
  discoveredAtMs: number;
  pairCreatedAtMs?: number;
  priceUsd?: number;
  liquidityUsd?: number;
  fdvUsd?: number;
  marketCapUsd?: number;
  activity: {
    m5?: TimeBucketActivity;
    h1?: TimeBucketActivity;
    h6?: TimeBucketActivity;
    h24?: TimeBucketActivity;
  };
  communitySuspiciousReports?: number;
  activeBoosts?: number;
  paidPromotion?: boolean;
  profilePresent?: boolean;
  websites?: string[];
  socials?: Array<{ platform?: string; handle?: string }>;
  raw?: unknown;
}

export interface SecurityHolder {
  address?: string;
  percent?: number;
  locked?: boolean;
  tag?: string;
}

export interface AssetSecuritySnapshot {
  source: 'goplus' | 'unknown';
  checkedAtMs: number;
  available: boolean;
  critical?: boolean;
  mintable?: boolean;
  freezable?: boolean;
  closable?: boolean;
  metadataMutable?: boolean;
  transferHookUpgradable?: boolean;
  maliciousAuthority?: boolean;
  holderCount?: number;
  topHolders?: SecurityHolder[];
  top10ConcentrationPct?: number;
  creatorPercent?: number;
  warnings: string[];
  raw?: unknown;
}

export type CatalystKind =
  | 'funding'
  | 'known_backer'
  | 'ecosystem_grant'
  | 'partnership'
  | 'exchange_listing'
  | 'mainnet'
  | 'community_takeover'
  | 'other';

export interface CatalystSignal {
  chain?: ScoutChain;
  tokenAddress?: string;
  project?: string;
  kind: CatalystKind;
  strength: 'low' | 'medium' | 'high';
  occurredAtMs: number;
  sourceName: string;
  sourceUrl?: string;
  verified: boolean;
  note?: string;
}

export interface ScoutScoreBreakdown {
  momentum: number;
  liquidity: number;
  flow: number;
  credibility: number;
  catalyst: number;
  opportunity: number;
  risk: number;
}

export interface ScoutAssessment {
  assessedAtMs: number;
  status: ScoutStatus;
  candidate: EmergingAssetCandidate;
  security: AssetSecuritySnapshot;
  catalysts: CatalystSignal[];
  scores: ScoutScoreBreakdown;
  reasons: string[];
  risks: string[];
  missing: string[];
}

export interface ScoutObservation {
  observedAtMs: number;
  chain: ScoutChain;
  tokenAddress: string;
  pairAddress?: string;
  priceUsd?: number;
  liquidityUsd?: number;
  assessment?: ScoutAssessment;
}

export interface HorizonPerformance {
  horizonMs: number;
  returnPct?: number;
  maxDrawdownPct?: number;
  liquidityChangePct?: number;
  observedAtMs?: number;
}

export interface ScoutPerformanceLabel {
  chain: ScoutChain;
  tokenAddress: string;
  firstObservedAtMs: number;
  firstPriceUsd?: number;
  firstLiquidityUsd?: number;
  horizons: HorizonPerformance[];
}
