import { expect, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import { ComponentsPage } from '../pages/ComponentsPage';
import { LoginPage } from '../pages/LoginPage';
import { config } from './config';
import { routes } from './routes';

type AuthenticationState = Exclude<BrowserContextOptions['storageState'], string | undefined>;
export type ComponentsSession = { context: BrowserContext; page: Page; components: ComponentsPage };

let primaryAuthentication: Promise<AuthenticationState> | undefined;

/**
 * Authenticates the primary automation user once per Playwright worker.
 * `expired` is set only when the saved state was observed to land on the login
 * page; the user then logs in again and the run-scoped state is replaced.
 */
export function primaryComponentsAuthentication(browser: Browser, expired = false): Promise<AuthenticationState> {
  if (expired) primaryAuthentication = undefined;
  primaryAuthentication ??= (async () => {
    const sharedStatePath = process.env.COMPONENTS_AUTH_STATE_PATH;
    if (sharedStatePath && !expired) {
      try {
        const stored = JSON.parse(await fs.readFile(sharedStatePath, 'utf8')) as AuthenticationState;
        console.log('Components authentication: reused the primary session created earlier in this run.');
        return stored;
      } catch {
        // The first worker owns authentication; replacement workers read its state.
      }
    }
    const context = await browser.newContext({ baseURL: config.baseUrl, viewport: null });
    try {
      const page = await context.newPage();
      const login = new LoginPage(page);
      await login.open();
      await login.loginForPms(config.username, config.password);
      console.log(expired
        ? 'Components authentication: the saved primary session had expired; the primary user logged in again (recovery).'
        : 'Components authentication: primary user logged in once for this worker.');
      const state = await context.storageState();
      if (sharedStatePath) await fs.writeFile(sharedStatePath, JSON.stringify(state), 'utf8');
      return state;
    } catch (error) {
      primaryAuthentication = undefined;
      throw error;
    } finally {
      await context.close();
    }
  })();
  return primaryAuthentication;
}

/** Opens an isolated Components context using the worker's authenticated state. */
export async function openPrimaryComponentsSession(browser: Browser): Promise<ComponentsSession> {
  const session = await openComponentsWithState(browser, await primaryComponentsAuthentication(browser));
  if (!(await landedOnLoginOrAccessDenied(session.page))) return finishOpening(session);
  // A replacement worker's saved state can expire during a long run. Log in
  // again only in that observed case; it is reported as an additional login.
  await session.context.close();
  return finishOpening(await openComponentsWithState(browser, await primaryComponentsAuthentication(browser, true)));
}

/** Opens an isolated authenticated PMS context directly on a requested PMS page without visiting Components. */
export async function openPrimaryPmsSession(
  browser: Browser,
  path = routes.runningHours,
): Promise<{ context: BrowserContext; page: Page }> {
  const open = async (expired = false) => {
    const storageState = await primaryComponentsAuthentication(browser, expired);
    const context = await browser.newContext({ baseURL: config.baseUrl, viewport: null, storageState });
    const page = await context.newPage();
    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          break;
        } catch (error) {
          if (attempt < 2) continue;
          throw error;
        }
      }
      return { context, page };
    } catch (error) {
      await context.close();
      throw error;
    }
  };
  let session = await open();
  const denied = /\/login(?:\/|$)/i.test(new URL(session.page.url()).pathname)
    || await session.page.getByRole('heading', { name: 'Access Denied', exact: true }).isVisible().catch(() => false);
  if (!denied) return session;
  await session.context.close();
  session = await open(true);
  return session;
}

async function landedOnLoginOrAccessDenied(page: Page): Promise<boolean> {
  const componentsHeading = page.getByRole('heading', { name: 'Components', exact: true });
  const accessDenied = page.getByRole('heading', { name: 'Access Denied', exact: true });
  let unusableSession = false;
  await expect.poll(async () => {
    unusableSession = /\/login(?:\/|$)/i.test(new URL(page.url()).pathname)
      || await accessDenied.isVisible().catch(() => false);
    return unusableSession || await componentsHeading.isVisible().catch(() => false);
  }, { timeout: 20_000 }).toBe(true).catch(() => undefined);
  return unusableSession;
}

async function finishOpening(session: { context: BrowserContext; page: Page }): Promise<ComponentsSession> {
  const components = new ComponentsPage(session.page);
  await components.expectToBeOnPage();
  console.log('Components authentication: reused the primary authenticated session.');
  return { ...session, components };
}

async function openComponentsWithState(browser: Browser, storageState: AuthenticationState): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: config.baseUrl, viewport: null, storageState });
  const page = await context.newPage();
  // One slow navigation must not block every later scenario in the group, so a
  // timed-out first attempt is retried once before the session is reported as unavailable.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.goto(routes.componentPage, { waitUntil: 'domcontentloaded' });
      break;
    } catch (error) {
      if (attempt < 2) continue;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Observed Application Result:\nThe Components page did not finish loading after two attempts while the authenticated test session was being opened, so this scenario could not start.\n\n${reason}`,
      );
    }
  }
  return { context, page };
}

/**
 * The Components page saves its search text, Critical Item filter, selection and expanded rows
 * per vessel in sessionStorage and re-applies them after a reload only once the tree data has
 * loaded, which can be after the next search was typed. Forgetting the saved view before a
 * reload or navigation makes the page start unfiltered.
 */
export async function forgetComponentsViewState(page: Page): Promise<void> {
  await page.evaluate(() => {
    const storage = globalThis.sessionStorage;
    for (const key of Object.keys(storage)) if (key.startsWith('pms-components-view-state:')) storage.removeItem(key);
  }).catch(() => undefined);
}

/** Restores a usable Components page after each test without another login. */
export async function restoreComponentsPage(
  page: Page,
  components: ComponentsPage,
  vessel?: string,
): Promise<void> {
  if (page.isClosed()) throw new Error('The Components browser page closed and cannot be recovered without a new session.');
  await page.goto(routes.componentPage, { waitUntil: 'domcontentloaded' });
  await components.expectToBeOnPage();
  if (vessel) await components.selectVessel(vessel);
}
