import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  RESEARCH_MARKETS,
  RESEARCH_MODES,
  RESEARCH_STATUSES,
  type ResearchMarket,
  type ResearchRegistry,
  type ResearchStrategyRecord,
} from './types.js';

const marketSet = new Set<string>(RESEARCH_MARKETS);
const statusSet = new Set<string>(RESEARCH_STATUSES);
const modeSet = new Set<string>(RESEARCH_MODES);

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function string(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(code);
  return value;
}

function stringArray(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(code);
  return value as string[];
}

export function parseResearchRegistry(value: unknown): ResearchRegistry {
  const root = object(value, 'REGISTRY_INVALID_ROOT');
  if (root.schemaVersion !== 1) throw new Error('REGISTRY_UNSUPPORTED_SCHEMA');
  string(root.checkpointDate, 'REGISTRY_CHECKPOINT_DATE_REQUIRED');
  string(root.mission, 'REGISTRY_MISSION_REQUIRED');

  const governance = object(root.governance, 'REGISTRY_GOVERNANCE_REQUIRED');
  if (governance.userQuestionIsNotPivot !== true) throw new Error('REGISTRY_GOVERNANCE_QUESTION_PIVOT_FORBIDDEN');
  if (governance.silentPivotForbidden !== true) throw new Error('REGISTRY_GOVERNANCE_SILENT_PIVOT_REQUIRED');
  if (governance.reuseFirstInventSecond !== true) throw new Error('REGISTRY_GOVERNANCE_REUSE_FIRST_REQUIRED');
  if (governance.shortestCrediblePath !== true) throw new Error('REGISTRY_GOVERNANCE_SHORTEST_PATH_REQUIRED');
  if (governance.realMoneyGate !== 'NO_GO') throw new Error('REGISTRY_REAL_MONEY_GATE_MUST_BE_NO_GO');
  if (governance.productionVersion !== '1.5.0') throw new Error('REGISTRY_PRODUCTION_VERSION_MISMATCH');

  if (!Array.isArray(root.strategies) || root.strategies.length === 0) throw new Error('REGISTRY_STRATEGIES_REQUIRED');
  const ids = new Set<string>();
  const strategies: ResearchStrategyRecord[] = root.strategies.map((raw, index) => {
    const item = object(raw, `REGISTRY_STRATEGY_${index}_INVALID`);
    const id = string(item.id, `REGISTRY_STRATEGY_${index}_ID_REQUIRED`);
    if (ids.has(id)) throw new Error(`REGISTRY_DUPLICATE_ID:${id}`);
    ids.add(id);

    const market = string(item.market, `REGISTRY_STRATEGY_${id}_MARKET_REQUIRED`);
    if (!marketSet.has(market)) throw new Error(`REGISTRY_STRATEGY_${id}_MARKET_INVALID`);
    const status = string(item.status, `REGISTRY_STRATEGY_${id}_STATUS_REQUIRED`);
    if (!statusSet.has(status)) throw new Error(`REGISTRY_STRATEGY_${id}_STATUS_INVALID`);
    const mode = string(item.mode, `REGISTRY_STRATEGY_${id}_MODE_REQUIRED`);
    if (!modeSet.has(mode)) throw new Error(`REGISTRY_STRATEGY_${id}_MODE_INVALID`);
    const implementation = object(item.implementation, `REGISTRY_STRATEGY_${id}_IMPLEMENTATION_REQUIRED`);
    const implementationKind = string(implementation.kind, `REGISTRY_STRATEGY_${id}_IMPLEMENTATION_KIND_REQUIRED`);
    if (!['existing_module', 'historical_runner', 'external_reference'].includes(implementationKind)) {
      throw new Error(`REGISTRY_STRATEGY_${id}_IMPLEMENTATION_KIND_INVALID`);
    }
    if (implementation.module !== undefined && typeof implementation.module !== 'string') {
      throw new Error(`REGISTRY_STRATEGY_${id}_IMPLEMENTATION_MODULE_INVALID`);
    }
    if (!Array.isArray(item.evidence)) throw new Error(`REGISTRY_STRATEGY_${id}_EVIDENCE_INVALID`);
    const evidence = item.evidence.map((rawEvidence, evidenceIndex) => {
      const evidenceItem = object(rawEvidence, `REGISTRY_STRATEGY_${id}_EVIDENCE_${evidenceIndex}_INVALID`);
      return {
        kind: string(evidenceItem.kind, `REGISTRY_STRATEGY_${id}_EVIDENCE_${evidenceIndex}_KIND_REQUIRED`),
        summary: string(evidenceItem.summary, `REGISTRY_STRATEGY_${id}_EVIDENCE_${evidenceIndex}_SUMMARY_REQUIRED`),
      };
    });
    if (item.realMoneyEligible !== false) throw new Error(`REGISTRY_REAL_MONEY_FORBIDDEN_V15:${id}`);
    if (item.nextTest !== null && typeof item.nextTest !== 'string') throw new Error(`REGISTRY_STRATEGY_${id}_NEXT_TEST_INVALID`);

    return {
      id,
      market: market as ResearchStrategyRecord['market'],
      status: status as ResearchStrategyRecord['status'],
      mode: mode as ResearchStrategyRecord['mode'],
      hypothesis: string(item.hypothesis, `REGISTRY_STRATEGY_${id}_HYPOTHESIS_REQUIRED`),
      implementation: {
        kind: implementationKind as ResearchStrategyRecord['implementation']['kind'],
        ...(implementation.module === undefined ? {} : { module: implementation.module as string }),
      },
      evidence,
      blockers: stringArray(item.blockers, `REGISTRY_STRATEGY_${id}_BLOCKERS_INVALID`),
      nextTest: item.nextTest as string | null,
      realMoneyEligible: false,
    };
  });

  return {
    schemaVersion: 1,
    checkpointDate: root.checkpointDate as string,
    mission: root.mission as string,
    governance: governance as unknown as ResearchRegistry['governance'],
    strategies,
  };
}

export async function loadResearchRegistry(path = 'research/registry.json'): Promise<ResearchRegistry> {
  const resolved = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolved, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`REGISTRY_READ_FAILED:${resolved}:${message}`);
  }
  return parseResearchRegistry(parsed);
}

export function filterResearchStrategies(registry: ResearchRegistry, market?: ResearchMarket): ResearchStrategyRecord[] {
  return market ? registry.strategies.filter((item) => item.market === market) : [...registry.strategies];
}

export function researchStatusCounts(strategies: ResearchStrategyRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const strategy of strategies) counts[strategy.status] = (counts[strategy.status] ?? 0) + 1;
  return counts;
}
