import { readFile } from 'node:fs/promises';
import type { CatalystSignal, EmergingAssetCandidate } from './types.js';

export async function loadCatalystSignals(path: string): Promise<CatalystSignal[]> {
  const text = await readFile(path, 'utf8');
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) return JSON.parse(trimmed) as CatalystSignal[];
  const rows: CatalystSignal[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as CatalystSignal);
    } catch (error) {
      throw new Error(`Invalid catalyst JSON at line ${index + 1}: ${String(error)}`);
    }
  }
  return rows;
}

export function catalystsForCandidate(candidate: EmergingAssetCandidate, signals: readonly CatalystSignal[]): CatalystSignal[] {
  const token = candidate.tokenAddress.toLowerCase();
  const symbol = candidate.tokenSymbol?.toLowerCase();
  const name = candidate.tokenName?.toLowerCase();
  return signals.filter((signal) => {
    if (signal.chain && signal.chain !== candidate.chain) return false;
    if (signal.tokenAddress) return signal.tokenAddress.toLowerCase() === token;
    const project = signal.project?.toLowerCase();
    return Boolean(project && (project === symbol || project === name));
  });
}
