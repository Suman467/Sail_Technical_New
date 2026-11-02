// Loads the application settings used by tests.
// Credentials stay in environment files and are validated once here.
import dotenv from 'dotenv';

dotenv.config({ override: true });

export const DATA_VALIDATION_LIMIT = 10;
export const BULK_IMPORT_MAX_UPLOAD_SIZE_MB = 20;
export const BULK_IMPORT_MAX_UPLOAD_SIZE_BYTES = BULK_IMPORT_MAX_UPLOAD_SIZE_MB * 1024 * 1024;
export const SPARE_LIMIT = 10

/**
 * Components linked-spares run settings (tests/components/components-linked-spares.spec.ts),
 * resolved by utils/componentRunSettings.ts. A PowerShell variable of the same purpose
 * (COMPONENT_LIMIT, SPARE_LIMIT, SPARE_SEED) overrides a value here, even when blank.
 */
export const LINKED_SPARES_SETTINGS: {
  componentLimit?: number | string | null;
  spareLimit?: number | string | null;
  spareSeed?: number | string | null;
} = {
  // CMP-142 to CMP-146: unique components each test case may inspect; undefined, null or "" = no limit.
  componentLimit: 60,
  // CMP-142/CMP-143 only: unique spares validated in total per test case (each case counts separately); undefined, null or "" = ALL spares.
  spareLimit: 60,
  // CMP-142/CMP-143 only: random seed for that sample; undefined, null or "" = new seed per test case.
  spareSeed: undefined,
};

/**
 * What this does: Reads a required environment variable and throws a clear error if it is missing.
 * When it's used: When the app settings are loaded before a test run starts.
 * @param name - The environment variable name that must exist.
 * @returns The value of the required environment variable.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} in .env. Add it before running the tests.`);
  }
  return value;
}

/**
 * Holds the app URLs and credentials used by the Playwright suite.
 */
export const config = {
  baseUrl: required('BASE_URL'),
  username: required('USERNAME'),
  password: required('PASSWORD'),
  domain: required('DOMAIN'),
  vesselName: required('VESSEL_NAME'),
  get vesselA(): string {
    return required('VESSEL_A');
  },
  get vesselB(): string {
    return required('VESSEL_B');
  },
  get componentCode(): string {
    return required('COMPONENT_CODE');
  },
  get emptyVessel(): string {
    return required('EMPTY_VESSEL');
  },
  get automationUser2Username(): string {
    return required('USERNAME_2');
  },
  get automationUser2Password(): string {
    return required('PASSWORD_2');
  },
  get cmp008ComponentPrefix(): string {
    return process.env.CMP008_COMPONENT_PREFIX?.trim() || 'AUTO-CMP008';
  },
  get cmp008ParentCode(): string {
    return process.env.CMP008_PARENT_CODE?.trim() || this.componentCode;
  },
  get componentDepartment(): string {
    return process.env.COMPONENT_DEPARTMENT?.trim() || 'Engine';
  },
} as const;
