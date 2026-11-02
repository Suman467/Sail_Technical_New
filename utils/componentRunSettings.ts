import { LINKED_SPARES_SETTINGS } from './config';

/**
 * Run settings for the Components linked-spares scenarios, edited in
 * LINKED_SPARES_SETTINGS in utils/config.ts:
 *
 *   componentLimit - unique components each scenario may inspect (blank = no limit)
 *   spareLimit     - unique spares validated in total per test case in CMP-142/CMP-143 (blank = ALL)
 *   spareSeed      - random seed for that sample (blank = generated once per test case)
 *
 * Each setting is resolved independently: an explicitly set environment variable
 * (COMPONENT_LIMIT, SPARE_LIMIT, SPARE_SEED) wins, even when blank; otherwise the
 * utils/config.ts value is used; otherwise the default behaviour applies.
 */

type RawSetting = { value: string | undefined; source: string };

const readSetting = (environmentName: string, key: keyof typeof LINKED_SPARES_SETTINGS): RawSetting => {
  const environment = process.env[environmentName];
  if (environment !== undefined) return { value: environment, source: `environment variable ${environmentName}` };
  const configured = LINKED_SPARES_SETTINGS[key];
  if (configured !== undefined && configured !== null) {
    return { value: String(configured), source: `utils/config.ts LINKED_SPARES_SETTINGS.${key}` };
  }
  return { value: undefined, source: 'default' };
};

const isBlank = (value: string | undefined) => value === undefined || value.trim() === '';
const wholeNumber = (value: string) => /^\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value.trim()));

export type ComponentLimitSetting = {
  /** Maximum unique components a scenario inspects; undefined means no limit. */
  limit?: number;
  source: string;
  error?: string;
  /** Business description for reports, for example "60 unique component(s) per test case (utils/config.ts LINKED_SPARES_SETTINGS.componentLimit)". */
  text: string;
};

/** Resolves the per-test-case component traversal limit shared by every linked-spares scenario. */
export function resolveComponentLimit(): ComponentLimitSetting {
  const { value, source } = readSetting('COMPONENT_LIMIT', 'componentLimit');
  if (isBlank(value)) return { source, text: `no limit (${source === 'default' ? 'not configured' : `blank in ${source}`})` };
  if (!wholeNumber(value!) || Number(value!.trim()) < 1) {
    return {
      source,
      error: `The component limit "${value}" from ${source} is not valid; it must be a positive whole number such as 10, 20 or 60, or blank for no limit.`,
      text: `invalid value "${value}" (${source})`,
    };
  }
  const limit = Number(value!.trim());
  return { limit, source, text: `${limit} unique component(s) per test case (${source})` };
}

export type SpareSamplingSetting = {
  mode: 'ALL' | 'LIMITED';
  limit?: number;
  limitSource: string;
  /** Effective seed, generated once per test case when none is configured. */
  seed: number;
  seedSource: string;
  seedGenerated: boolean;
  error?: string;
};

/** Resolves the CMP-142/CMP-143 spare sample size and seed; call once per test case. */
export function resolveSpareSampling(): SpareSamplingSetting {
  const limitSetting = readSetting('SPARE_LIMIT', 'spareLimit');
  const seedSetting = readSetting('SPARE_SEED', 'spareSeed');
  const errors: string[] = [];
  const seedGiven = !isBlank(seedSetting.value);
  const seedValid = seedGiven && wholeNumber(seedSetting.value!) && Number(seedSetting.value!.trim()) <= 0xffffffff;
  if (seedGiven && !seedValid) {
    errors.push(`The spare seed "${seedSetting.value}" from ${seedSetting.source} is not valid; it must be a whole number from 0 to 4294967295, or blank to generate one.`);
  }
  const seed = seedValid ? Number(seedSetting.value!.trim()) : Math.floor(Math.random() * 0x100000000);
  const base = {
    seed,
    seedGenerated: !seedValid,
    seedSource: seedValid ? seedSetting.source : 'generated for this test case',
    limitSource: limitSetting.source,
  };
  if (isBlank(limitSetting.value)) return { mode: 'ALL', ...base, error: errors.join(' ') || undefined };
  if (!wholeNumber(limitSetting.value!) || Number(limitSetting.value!.trim()) < 1) {
    errors.unshift(`The spare limit "${limitSetting.value}" from ${limitSetting.source} is not valid; it must be a positive whole number such as 5 or 20, or blank to validate all spares.`);
  }
  return { mode: 'LIMITED', limit: Number(limitSetting.value!.trim()), ...base, error: errors.join(' ') || undefined };
}
