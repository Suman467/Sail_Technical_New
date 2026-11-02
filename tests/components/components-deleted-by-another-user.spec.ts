import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { ComponentsPage, type SelectedComponentIdentity } from '../../pages/ComponentsPage';
import { LoginPage } from '../../pages/LoginPage';
import { componentValidationStep } from '../../utils/componentValidationEvidence';
import { removeTrackedComponent, trackCreatedComponent } from '../../utils/componentCreationTracker';
import { openPrimaryComponentsSession, restoreComponentsPage } from '../../utils/componentsSession';
import { config } from '../../utils/config';

const componentStep = (title: string, expected: string, actual: string): string =>
  `${title}\nExpected: ${expected}\nActual: ${actual}`;

type UserSession = {
  name: string;
  context: BrowserContext;
  page: Page;
  components: ComponentsPage;
};

// Activates the user's top-level page through Playwright so headed runs visibly
// follow the same session that is performing the next business action.
const activateSession = async (session: UserSession): Promise<void> => {
  await session.page.bringToFront();
};

test.describe.serial('Components concurrent-user deletion', () => {
  let user1: UserSession;
  let user2: UserSession | undefined;

  const openSession = async (
    browser: Browser,
    username: string,
    password: string,
  ): Promise<UserSession> => {
    const context = await browser.newContext({ baseURL: config.baseUrl, viewport: null });
    const page = await context.newPage();
    await page.bringToFront();
    const login = new LoginPage(page);
    await login.open();
    const dashboard = await login.login(username, password, config.domain);
    const components = await (await dashboard.goToTechnical()).goToComponents();
    await components.expectToBeOnPage();
    return { name: username, context, page, components };
  };

  test.beforeAll(async ({ browser }) => {
    const session = await openPrimaryComponentsSession(browser);
    user1 = { name: config.username, ...session };
  });

  test.afterEach(async () => {
    await restoreComponentsPage(user1.page, user1.components, config.vesselA);
  });

  test.afterAll(async () => {
    await Promise.allSettled([user2?.context.close(), user1?.context.close()]);
  });

  /**
   * CMP-008 creates one disposable component, keeps both user sessions open,
   * and verifies User 2 sees an empty tree/details state after User 1 deletes it.
   */
  test(
    'CMP-008 - Open Component Removed by Another User',
    { tag: ['@regression', '@components', '@concurrency', '@positive'] },
    async ({ browser }) => {
      test.setTimeout(3 * 60 * 1000);
      const vessel = config.vesselA;
      const parentCode = config.cmp008ParentCode;
      const prefix = config.cmp008ComponentPrefix
        .replace(/[^a-z0-9-]/gi, '')
        .slice(0, 20);
      const runtimeId = `${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 6)}`.toUpperCase();
      const componentCode = `${prefix}-${runtimeId}`;
      const componentName = `${prefix} Disposable ${runtimeId}`;
      const runId = `${new Date().toISOString()}-${runtimeId}`;
      let created: SelectedComponentIdentity | undefined;
      let deletionCompleted = false;

      try {
        await componentValidationStep(user1.page, componentStep(
          `Select Vessel ${vessel} as ${user1.name}`,
          `${user1.name} should open a usable Components tree for Vessel ${vessel}.`,
          `${user1.name} opened a usable Components tree for Vessel ${vessel}.`,
        ), async () => {
          await activateSession(user1);
          await user1.components.clearComponentSearch();
          await user1.components.selectVessel(vessel);
          await user1.components.expectTreeLoaded();
        });

        await componentValidationStep(user1.page, componentStep(
          `Create Component ${componentCode} (${componentName}) in Vessel ${vessel}`,
          `${user1.name} should create one disposable component under Parent ${parentCode}.`,
          `${user1.name} created Component ${componentCode} (${componentName}) under Parent ${parentCode}.`,
        ), async () => {
          await activateSession(user1);
          const form = await user1.components.openComponentForAdd();
          await form.fillMandatoryFields(componentCode, componentName, parentCode);
          expect(await form.save(), `Component ${componentCode} should be created`).toBe(true);
          await trackCreatedComponent({ code: componentCode, name: componentName, vessel, parentCode, sourceSpec: 'components-deleted-by-another-user.spec.ts', testCaseId: 'CMP-008', runId, createdAt: new Date().toISOString() });
          created = { code: componentCode, name: componentName, vesselName: vessel };
        });

        await componentValidationStep(user1.page, componentStep(
          `${user1.name} searches Component ${componentCode} in Vessel ${vessel}`,
          `Component ${componentCode} (${componentName}) should be present for ${user1.name}.`,
          `${user1.name} found and opened Component ${componentCode} (${componentName}) in Vessel ${vessel}.`,
        ), async () => {
          await activateSession(user1);
          created = await user1.components.searchAndSelectComponentByCode(componentCode);
          expect(created).toEqual({ code: componentCode, name: componentName, vesselName: vessel });
        });

        user2 = await componentValidationStep(user1.page, componentStep(
          `Login as ${config.automationUser2Username} in a separate session`,
          `${config.automationUser2Username} should authenticate without closing ${user1.name}'s session.`,
          `${config.automationUser2Username} authenticated in a separate browser context while ${user1.name} remained logged in.`,
        ), async () => openSession(
          browser,
          config.automationUser2Username,
          config.automationUser2Password,
        ));

        await componentValidationStep(user2.page, componentStep(
          `Select Vessel ${vessel} as ${user2.name}`,
          `${user2.name} should open the same Vessel ${vessel}.`,
          `${user2.name} opened Vessel ${vessel}.`,
        ), async () => {
          await activateSession(user2!);
          await user2!.components.selectVessel(vessel);
          await user2!.components.expectTreeLoaded();
        });

        await componentValidationStep(user2.page, componentStep(
          `${user2.name} searches Component ${componentCode} in Vessel ${vessel}`,
          `${user2.name} should find the exact Component ${componentCode} (${componentName}).`,
          `${user2.name} found and opened Component ${componentCode} (${componentName}) in Vessel ${vessel}.`,
        ), async () => {
          await activateSession(user2!);
          const identity = await user2!.components.searchAndSelectComponentByCode(componentCode);
          expect(identity).toEqual(created);
        });

        await componentValidationStep(user1.page, componentStep(
          `Delete Component ${componentCode} (${componentName}) as ${user1.name}`,
          `${user1.name} should delete only the disposable Component ${componentCode}.`,
          `${user1.name} deleted Component ${componentCode} (${componentName}) from Vessel ${vessel}.`,
        ), async () => {
          await activateSession(user1);
          expect(await user1.components.deleteSelectedComponent(componentCode)).not.toBe('');
          deletionCompleted = true;
        });

        await componentValidationStep(user2.page, componentStep(
          `${user2.name} searches deleted Component ${componentCode} in Vessel ${vessel}`,
          `The full-code search should contain no Component ${componentCode} node.`,
          `${user2.name}'s full-code search contained no Component ${componentCode} node.`,
        ), async () => {
          await activateSession(user2!);
          // The application does not push cross-session tree changes, so one
          // register reload is required while preserving User 2's login.
          await user2!.page.reload({ waitUntil: 'domcontentloaded' });
          await user2!.components.expectToBeOnPage();
          await user2!.components.expectVesselSelected(vessel);
          const result = await user2!.components.expectComponentAbsentFromSearch(
            componentCode,
            componentCode,
            vessel,
          );
          expect(result.exactComponentMatches).toBe(0);
          await removeTrackedComponent(componentCode, vessel);
        });

        await componentValidationStep(user2.page, componentStep(
          `Verify empty Components tree for ${user2.name} search ${componentCode}`,
          `The scoped left Components tree should be empty for deleted Component ${componentCode}.`,
          `The scoped left Components tree was empty for deleted Component ${componentCode}.`,
        ), async () => {
          await activateSession(user2!);
          await user2!.components.expectFilteredTreeEmpty(componentCode);
        });

        await componentValidationStep(user2.page, componentStep(
          `Verify empty details panel for deleted Component ${componentCode}`,
          `The scoped right panel should display "Select a component to view details" with no substituted component.`,
          `The scoped right panel displayed "Select a component to view details" and no component was selected.`,
        ), async () => {
          await activateSession(user2!);
          await user2!.components.expectEmptyComponentDetails();
        });
      } catch (error) {
        if (created && !deletionCompleted) {
          let cleanupFailure = '';
          try {
            await activateSession(user1);
            await user1.page.reload({ waitUntil: 'domcontentloaded' });
            await user1.components.expectToBeOnPage();
            await user1.components.selectVessel(vessel);
            await user1.components.searchAndSelectComponentByCode(componentCode);
            await user1.components.deleteSelectedComponent(componentCode);
            await user1.page.reload({ waitUntil: 'domcontentloaded' });
            await user1.components.expectToBeOnPage();
            await user1.components.selectVessel(vessel);
            if (await user1.components.exactComponentCount(componentCode) === 0) {
              await removeTrackedComponent(componentCode, vessel);
            }
          } catch (cleanupError) {
            cleanupFailure = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          }
          if (cleanupFailure) {
            const record = [
              'CMP-008 LEFTOVER COMPONENT - SAFE CLEANUP REQUIRED',
              `Component Code: ${componentCode}`,
              `Component Name: ${componentName}`,
              `Vessel: ${vessel}`,
              `Parent Code: ${parentCode}`,
              `Cleanup Failure: ${cleanupFailure}`,
            ].join('\n');
            await test.info().attach('CMP-008 Leftover Component Cleanup Record', {
              body: Buffer.from(record),
              contentType: 'text/plain',
            });
            throw new Error(`${error instanceof Error ? error.message : String(error)}\n${record}`, { cause: error });
          }
        }
        throw error;
      }
    },
  );
});
