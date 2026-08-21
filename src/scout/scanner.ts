import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { catalystsForCandidate } from './catalysts.js';
import { fetchDexScreenerEnrichment } from './dexscreener.js';
import { fetchGeckoTerminalNewPools } from './geckoterminal.js';
import { fetchGoPlusSecurity } from './goplus.js';
import { assessEmergingAsset } from './scoring.js';
import type { CatalystSignal, EmergingAssetCandidate, ScoutAssessment, ScoutChain, ScoutObservation } from './types.js';

export interface ScoutCycleOptions {
  chains?: ScoutChain[];
  maxCandidatesPerChain?: number;
  minLiquidityUsd?: number;
  fetchImpl?: typeof fetch;
  goPlusAccessToken?: string;
  catalysts?: CatalystSignal[];
  includePaidOrders?: boolean;
}

export interface ScoutCycleResult {
  scannedAtMs: number;
  discovered: number;
  assessed: ScoutAssessment[];
  errors: string[];
}

function dedupe(candidates: EmergingAssetCandidate[]): EmergingAssetCandidate[] {
  const map = new Map<string, EmergingAssetCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.chain}:${candidate.tokenAddress.toLowerCase()}`;
    const previous = map.get(key);
    if (!previous || (candidate.liquidityUsd ?? 0) > (previous.liquidityUsd ?? 0)) map.set(key, candidate);
  }
  return [...map.values()];
}

export async function runScoutCycle(options: ScoutCycleOptions = {}): Promise<ScoutCycleResult> {
  const chains = options.chains ?? ['solana', 'base'];
  const maxCandidates = options.maxCandidatesPerChain ?? 20;
  const fetchImpl = options.fetchImpl ?? fetch;
  const discovered: EmergingAssetCandidate[] = [];
  const errors: string[] = [];

  for (const chain of chains) {
    try {
      const rows = await fetchGeckoTerminalNewPools(chain, { fetchImpl, includeCommunityData: true });
      discovered.push(...rows.slice(0, maxCandidates));
    } catch (error) {
      errors.push(`geckoterminal:${chain}:${String(error)}`);
    }
  }

  const assessed: ScoutAssessment[] = [];
  for (const baseCandidate of dedupe(discovered)) {
    let candidate = baseCandidate;
    try {
      candidate = await fetchDexScreenerEnrichment(candidate, { fetchImpl, includePaidOrders: options.includePaidOrders });
    } catch (error) {
      errors.push(`dexscreener:${candidate.chain}:${candidate.tokenAddress}:${String(error)}`);
    }

    let security;
    try {
      security = await fetchGoPlusSecurity(candidate, { accessToken: options.goPlusAccessToken, fetchImpl });
    } catch (error) {
      errors.push(`goplus:${candidate.chain}:${candidate.tokenAddress}:${String(error)}`);
      security = { source: 'unknown' as const, checkedAtMs: Date.now(), available: false, warnings: ['Security provider request failed.'] };
    }

    assessed.push(assessEmergingAsset(
      candidate,
      security,
      catalystsForCandidate(candidate, options.catalysts ?? []),
      { minLiquidityUsd: options.minLiquidityUsd },
    ));
  }

  assessed.sort((a, b) => {
    const statusRank = { HIGH_INTEREST: 0, WATCH: 1, SECURITY_PENDING: 2, REJECT: 3 } as const;
    return statusRank[a.status] - statusRank[b.status] || b.scores.opportunity - a.scores.opportunity || a.scores.risk - b.scores.risk;
  });
  return { scannedAtMs: Date.now(), discovered: dedupe(discovered).length, assessed, errors };
}

export function assessmentToObservation(assessment: ScoutAssessment): ScoutObservation {
  return {
    observedAtMs: assessment.assessedAtMs,
    chain: assessment.candidate.chain,
    tokenAddress: assessment.candidate.tokenAddress,
    pairAddress: assessment.candidate.pairAddress,
    priceUsd: assessment.candidate.priceUsd,
    liquidityUsd: assessment.candidate.liquidityUsd,
    assessment,
  };
}

export async function appendScoutAssessments(path: string, assessments: readonly ScoutAssessment[]): Promise<void> {
  if (assessments.length === 0) return;
  await mkdir(dirname(path), { recursive: true });
  const text = assessments.map((x) => JSON.stringify(assessmentToObservation(x))).join('\n') + '\n';
  await appendFile(path, text, 'utf8');
}
