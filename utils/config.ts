// Loads the application settings used by tests.
// Credentials stay in environment files and are validated once here.
import dotenv from 'dotenv';

dotenv.config({ override: true });

export const DATA_VALIDATION_LIMIT = 10;
export const BULK_IMPORT_MAX_UPLOAD_SIZE_MB = 20;
export const BULK_IMPORT_MAX_UPLOAD_SIZE_BYTES = BULK_IMPORT_MAX_UPLOAD_SIZE_MB * 1024 * 1024;

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
} as const;
