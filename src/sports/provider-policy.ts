export type SportsProviderId = 'bet365' | 'betfair-exchange' | 'smarkets-exchange' | 'polymarket-sports' | 'other-bookmaker';

export type SportsDataProvenance =
  | 'OFFICIAL_API'
  | 'OFFICIAL_DELAYED_API'
  | 'OFFICIAL_HISTORICAL'
  | 'EXPLICIT_RESEARCH_LICENSE'
  | 'LICENSED_FEED'
  | 'MANUAL_RESEARCH'
  | 'UNKNOWN';

export interface SportsProviderPolicy {
  provider: SportsProviderId;
  role: 'REFERENCE_ONLY' | 'RESEARCH_PAPER_CANDIDATE';
  automatedExecutionEnabled: false;
  scrapingAllowedByFluxQuant: false;
  allowedResearchProvenance: readonly SportsDataProvenance[];
  note: string;
}

const POLICIES: Record<SportsProviderId, SportsProviderPolicy> = {
  bet365: {
    provider: 'bet365',
    role: 'REFERENCE_ONLY',
    automatedExecutionEnabled: false,
    scrapingAllowedByFluxQuant: false,
    allowedResearchProvenance: ['EXPLICIT_RESEARCH_LICENSE', 'LICENSED_FEED'],
    note: 'Reference-only. FluxQuant does not scrape, automate, or place Bet365 bets. Use only a source contract/feed that explicitly authorizes this research use; manually copied Bet365 odds are not accepted into the engine.',
  },
  'betfair-exchange': {
    provider: 'betfair-exchange',
    role: 'RESEARCH_PAPER_CANDIDATE',
    automatedExecutionEnabled: false,
    scrapingAllowedByFluxQuant: false,
    allowedResearchProvenance: ['OFFICIAL_DELAYED_API', 'OFFICIAL_HISTORICAL', 'EXPLICIT_RESEARCH_LICENSE', 'LICENSED_FEED'],
    note: 'Research/paper only. Betfair analysis should use delayed application-key data, official historical data, or another explicitly licensed source; generic live read-only API provenance is intentionally not accepted.',
  },
  'smarkets-exchange': {
    provider: 'smarkets-exchange',
    role: 'RESEARCH_PAPER_CANDIDATE',
    automatedExecutionEnabled: false,
    scrapingAllowedByFluxQuant: false,
    allowedResearchProvenance: ['EXPLICIT_RESEARCH_LICENSE', 'LICENSED_FEED'],
    note: 'Research/paper only and fail-closed. Generic Smarkets API access is not treated as permission to extract/benchmark prices; use only a source contract that explicitly permits this research use.',
  },
  'polymarket-sports': {
    provider: 'polymarket-sports',
    role: 'REFERENCE_ONLY',
    automatedExecutionEnabled: false,
    scrapingAllowedByFluxQuant: false,
    allowedResearchProvenance: ['OFFICIAL_API', 'OFFICIAL_HISTORICAL', 'EXPLICIT_RESEARCH_LICENSE'],
    note: 'Reference-only in this baseline. Its binary-share fee/depth/execution mechanics need a dedicated paper model; use official streams/APIs only when normally reachable and geographically eligible.',
  },
  'other-bookmaker': {
    provider: 'other-bookmaker',
    role: 'REFERENCE_ONLY',
    automatedExecutionEnabled: false,
    scrapingAllowedByFluxQuant: false,
    allowedResearchProvenance: ['EXPLICIT_RESEARCH_LICENSE', 'LICENSED_FEED', 'MANUAL_RESEARCH'],
    note: 'Reference-only. No scraping or automated execution; the ingestion layer must record a source contract that permits the research use.',
  },
};

export function sportsProviderPolicy(provider: SportsProviderId): SportsProviderPolicy {
  const policy = POLICIES[provider];
  if (!policy) throw new Error(`SPORTS_UNKNOWN_PROVIDER:${provider}`);
  return { ...policy, allowedResearchProvenance: [...policy.allowedResearchProvenance] };
}

export function researchProvenanceAllowed(provider: SportsProviderId, provenance: SportsDataProvenance | undefined): boolean {
  if (!provenance || provenance === 'UNKNOWN') return false;
  return sportsProviderPolicy(provider).allowedResearchProvenance.includes(provenance);
}
