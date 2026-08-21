import type { AssetSecuritySnapshot, CatalystSignal, EmergingAssetCandidate, ScoutAssessment, ScoutStatus } from './types.js';

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function logScore(value: number | undefined, low: number, high: number): number {
  if (value === undefined || value <= 0) return 0;
  if (value <= low) return 0;
  if (value >= high) return 100;
  const x = (Math.log(value) - Math.log(low)) / (Math.log(high) - Math.log(low));
  return clamp(x * 100);
}

function flowScore(candidate: EmergingAssetCandidate): number {
  const row = candidate.activity.m5 ?? candidate.activity.h1;
  if (!row) return 0;
  const buys = row.buys ?? 0;
  const sells = row.sells ?? 0;
  const buyers = row.buyers ?? buys;
  const sellers = row.sellers ?? sells;
  const tradeRatio = (buys + 1) / (sells + 1);
  const walletRatio = (buyers + 1) / (sellers + 1);
  const tradeComponent = clamp((Math.log2(tradeRatio) + 1) * 35, 0, 70);
  const diversityComponent = clamp((Math.log2(walletRatio) + 1) * 15, 0, 30);
  return clamp(tradeComponent + diversityComponent);
}

function momentumScore(candidate: EmergingAssetCandidate): number {
  const m5 = candidate.activity.m5?.priceChangePct;
  const h1 = candidate.activity.h1?.priceChangePct;
  const volume = candidate.activity.m5?.volumeUsd ?? candidate.activity.h1?.volumeUsd;
  const price = clamp(((m5 ?? 0) * 1.5 + (h1 ?? 0) * 0.5) + 30, 0, 75);
  const vol = logScore(volume, 500, 100_000) * 0.25;
  return clamp(price + vol);
}

function liquidityScore(candidate: EmergingAssetCandidate): number {
  const liquidity = logScore(candidate.liquidityUsd, 1_000, 250_000);
  const turnover = candidate.liquidityUsd && candidate.activity.h1?.volumeUsd
    ? candidate.activity.h1.volumeUsd / candidate.liquidityUsd
    : 0;
  const healthyTurnover = clamp(turnover * 35, 0, 25);
  return clamp(liquidity * 0.75 + healthyTurnover);
}

function credibilityScore(candidate: EmergingAssetCandidate, security: AssetSecuritySnapshot): number {
  let score = 15;
  if (candidate.profilePresent) score += 10;
  if ((candidate.websites?.length ?? 0) > 0) score += 10;
  if ((candidate.socials?.length ?? 0) > 0) score += 10;
  if ((candidate.communitySuspiciousReports ?? 0) > 0) score -= 25;
  if (security.available) score += 25;
  if (security.available && security.critical === false) score += 15;
  if (security.mintable === false) score += 5;
  if (security.freezable === false) score += 5;
  if (security.maliciousAuthority) score -= 50;
  return clamp(score);
}

function catalystScore(catalysts: readonly CatalystSignal[]): number {
  const verified = catalysts.filter((x) => x.verified);
  const weight = { low: 10, medium: 25, high: 45 } as const;
  return clamp(verified.reduce((sum, x) => sum + weight[x.strength], 0));
}

function riskScore(candidate: EmergingAssetCandidate, security: AssetSecuritySnapshot): number {
  let risk = 0;
  const ageMinutes = candidate.pairCreatedAtMs ? (candidate.discoveredAtMs - candidate.pairCreatedAtMs) / 60_000 : undefined;
  if (ageMinutes !== undefined && ageMinutes < 10) risk += 20;
  else if (ageMinutes !== undefined && ageMinutes < 60) risk += 10;
  if ((candidate.liquidityUsd ?? 0) < 5_000) risk += 35;
  else if ((candidate.liquidityUsd ?? 0) < 20_000) risk += 15;
  if ((candidate.communitySuspiciousReports ?? 0) > 0) risk += 20;
  if (candidate.paidPromotion) risk += 8; // paid attention is not treated as organic quality
  if (!security.available) risk += 20;
  if (security.mintable) risk += 10;
  if (security.freezable) risk += 25;
  if (security.closable) risk += 35;
  if (security.metadataMutable) risk += 5;
  if (security.transferHookUpgradable) risk += 15;
  if (security.maliciousAuthority) risk += 70;
  if ((security.creatorPercent ?? 0) >= 20) risk += 15;
  if ((security.creatorPercent ?? 0) >= 50) risk += 30;
  if ((security.top10ConcentrationPct ?? 0) >= 80) risk += 15;
  if ((security.top10ConcentrationPct ?? 0) >= 95) risk += 30;
  return clamp(risk);
}

export interface ScoutScoringOptions {
  minLiquidityUsd?: number;
  highInterestOpportunity?: number;
  maxHighInterestRisk?: number;
}

export function assessEmergingAsset(
  candidate: EmergingAssetCandidate,
  security: AssetSecuritySnapshot,
  catalysts: readonly CatalystSignal[] = [],
  options: ScoutScoringOptions = {},
): ScoutAssessment {
  const minLiquidityUsd = options.minLiquidityUsd ?? 5_000;
  const momentum = momentumScore(candidate);
  const liquidity = liquidityScore(candidate);
  const flow = flowScore(candidate);
  const credibility = credibilityScore(candidate, security);
  const catalyst = catalystScore(catalysts);
  const opportunity = clamp(momentum * 0.30 + liquidity * 0.25 + flow * 0.25 + credibility * 0.15 + catalyst * 0.05);
  const risk = riskScore(candidate, security);

  const reasons: string[] = [];
  const risks: string[] = [...security.warnings];
  const missing: string[] = [];

  if (momentum >= 65) reasons.push('Short-horizon price/volume momentum is elevated.');
  if (flow >= 65) reasons.push('Recent buy-side flow is stronger than sell-side flow.');
  if (liquidity >= 65) reasons.push('Liquidity is meaningful for a fresh pool.');
  if (catalyst >= 25) reasons.push('At least one verified catalyst is attached.');
  if (candidate.paidPromotion) risks.push('Paid promotion/boost detected; not counted as organic conviction.');
  if ((candidate.liquidityUsd ?? 0) < minLiquidityUsd) risks.push(`Liquidity below minimum research threshold ($${minLiquidityUsd}).`);
  if (!security.available) missing.push('Security scan unavailable.');
  if (security.holderCount === undefined) missing.push('Holder count unavailable.');
  if (security.top10ConcentrationPct === undefined) missing.push('Top-holder concentration unavailable.');
  if (candidate.marketCapUsd === undefined) missing.push('Verified market cap unavailable; FDV is not substituted as market cap.');

  let status: ScoutStatus = 'WATCH';
  if (security.critical || (candidate.liquidityUsd ?? 0) < minLiquidityUsd || risk >= 80) status = 'REJECT';
  else if (!security.available) status = 'SECURITY_PENDING';
  else if (opportunity >= (options.highInterestOpportunity ?? 75) && risk <= (options.maxHighInterestRisk ?? 35)) status = 'HIGH_INTEREST';

  return {
    assessedAtMs: Date.now(),
    status,
    candidate,
    security,
    catalysts: [...catalysts],
    scores: { momentum, liquidity, flow, credibility, catalyst, opportunity, risk },
    reasons,
    risks,
    missing,
  };
}
