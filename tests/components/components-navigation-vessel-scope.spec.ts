import { test, type BrowserContext, type Page } from '@playwright/test';
import { ComponentsPage } from '../../pages/ComponentsPage';
import { TechnicalPage } from '../../pages/TechnicalPage';
import { componentValidationStep } from '../../utils/componentValidationEvidence';
import { openPrimaryComponentsSession, restoreComponentsPage } from '../../utils/componentsSession';
import { config } from '../../utils/config';

const componentStep = (title: string, expected: string, actual: string): string =>
  `${title}\nExpected: ${expected}\nActual: ${actual}`;

test.describe('Components navigation and vessel scope', () => {
  let context: BrowserContext;
  let page: Page;
  let componentsPage: ComponentsPage;

  test.beforeAll(async ({ browser }) => {
    ({ context, page, components: componentsPage } = await openPrimaryComponentsSession(browser));
  });

  test.afterEach(async () => {
    await restoreComponentsPage(page, componentsPage, config.vesselName);
  });

  test.afterAll(async () => {
    await context?.close();
  });

/**
 * CMP-001 verifies that an authenticated user can navigate through
 * Technical > PMS > Components and receive a usable vessel-scoped workspace.
 */
test(
  'CMP-001 - Navigate to PMS Components and verify page loading',
  { tag: ['@smoke', '@regression', '@components', '@navigation', '@positive'] },
  async () => {
    await componentValidationStep(page,
      componentStep(
        'Verify PMS Components page is ready',
        'The shared Technical > PMS > Components page should load successfully.',
        'The Components page URL and heading were displayed.',
      ),
      async () => {
        await componentsPage.expectToBeOnPage();
      },
    );

    await componentValidationStep(page,
      componentStep(
        `Select Vessel ${config.vesselName}`,
        `Vessel ${config.vesselName} should be selected and its Components data should load successfully.`,
        `Vessel ${config.vesselName} was selected from the configured environment value.`,
      ),
      async () => {
        await componentsPage.selectVessel(config.vesselName);
      },
    );

    await componentValidationStep(page,
      componentStep(
        `Verify Vessel ${config.vesselName} Components workspace`,
        `Vessel dropdown, component search, Components tree, and details area should be displayed for ${config.vesselName}.`,
        `All required Components workspace elements were displayed for Vessel ${config.vesselName}.`,
      ),
      async () => {
        await componentsPage.expectWorkspaceVisible(config.vesselName);
      },
    );

    await componentValidationStep(page,
      componentStep(
        `Verify Vessel ${config.vesselName} Components tree loading`,
        `The Components tree for Vessel ${config.vesselName} should finish loading and become usable.`,
        `The Components tree for Vessel ${config.vesselName} displayed rows and was not left loading.`,
      ),
      async () => {
        await componentsPage.expectTreeLoaded();
      },
    );
  },
);

/**
 * CMP-002 verifies that a configured Vessel A component can be found through
 * the filtered hierarchy, opened, and reopened with the same identity after refresh.
 */
test(
  `CMP-002 - Select Vessel ${config.vesselA} and open Component ${config.componentCode}`,
  { tag: ['@regression', '@components', '@navigation', '@positive'] },
  async () => {
    const vesselA = config.vesselA;
    const componentCode = config.componentCode;

    await componentValidationStep(page,
      componentStep(
        `Select Vessel ${vesselA}`,
        `Vessel ${vesselA} should be selected and its Components tree should load successfully.`,
        `Vessel ${vesselA} was selected and its Components tree loaded successfully.`,
      ),
      async () => {
        await componentsPage.selectVessel(vesselA);
        await componentsPage.expectTreeLoaded();
      },
    );

    const selected = await componentValidationStep(page,
      componentStep(
        `Select Component ${componentCode}`,
        `Component ${componentCode} should be found through the required tree nodes and displayed in the details panel.`,
        `Component ${componentCode} was found, selected, and displayed in the details panel.`,
      ),
      async () => componentsPage.searchAndSelectComponentByCode(componentCode),
    );

    await componentValidationStep(page,
      componentStep(
        `Validate Component ${selected.code} (${selected.name}) details`,
        `Details should show Component ${componentCode}, its selected name, and Vessel ${vesselA}.`,
        `Details showed Component ${selected.code} (${selected.name}) for Vessel ${selected.vesselName}.`,
      ),
      async () => {
        await test.expect(selected.code, 'The details panel should show the configured component code').toBe(componentCode);
        await test.expect(selected.name, 'The selected component should expose a Component Name').not.toBe('');
        await test.expect(selected.vesselName, 'The selected component should belong to Vessel A').toBe(vesselA);
      },
    );

    await componentValidationStep(page,
      componentStep(
        `Refresh and reopen Component ${selected.code} (${selected.name})`,
        `After refresh, Component ${selected.code} (${selected.name}) should reopen for Vessel ${vesselA}.`,
        `Component ${selected.code} (${selected.name}) reopened for Vessel ${vesselA}; no other component was selected.`,
      ),
      async () => {
        await page.reload();
        await componentsPage.expectToBeOnPage();
        await componentsPage.selectVessel(vesselA);
        await componentsPage.expectTreeLoaded();
        const reopened = await componentsPage.searchAndSelectComponentByCode(componentCode);

        await test.expect(reopened).toEqual(selected);
      },
    );
  },
);

/** CMP-003 verifies that selecting another component replaces the previous details. */
test(
  'CMP-003 - Switch selected component from A to B',
  { tag: ['@regression', '@components', '@navigation', '@positive'] },
  async () => {
    const vessel = config.vesselA;
    const componentA = config.componentCode;

    await componentValidationStep(page,
      componentStep(
        `Select Vessel ${vessel}`,
        `Vessel ${vessel} should be selected with a usable Components tree.`,
        `Vessel ${vessel} was selected and its Components tree loaded successfully.`,
      ),
      async () => {
        await componentsPage.clearComponentSearch();
        await componentsPage.selectVessel(vessel);
        await componentsPage.expectTreeLoaded();
      },
    );

    const first = await componentValidationStep(page,
      componentStep(
        `Select Component ${componentA}`,
        `Component ${componentA} should open in the details panel.`,
        `Component ${componentA} opened with its configured identity.`,
      ),
      async () => componentsPage.searchAndSelectComponentByCode(componentA),
    );
    const identifiedComponentB = await componentsPage.selectAlternativeComponent(componentA, vessel);
    await componentsPage.searchAndSelectComponentByCode(componentA);
    const second = await componentValidationStep(page,
      componentStep(
        `Switch to Component ${identifiedComponentB.code} (${identifiedComponentB.name})`,
        `Component ${identifiedComponentB.code} (${identifiedComponentB.name}) should replace Component ${first.code} (${first.name}) in the details panel.`,
        `Component ${identifiedComponentB.code} (${identifiedComponentB.name}) replaced Component ${first.code} (${first.name}) in the details panel.`,
      ),
      async () => componentsPage.searchAndSelectComponentByCode(identifiedComponentB.code),
    );

    await componentValidationStep(page,
      componentStep(
        `Validate Component ${second.code} (${second.name}) details`,
        `The panel should show Component ${second.code} (${second.name}) for Vessel ${vessel}, without retaining Component ${first.code} (${first.name}).`,
        `The panel showed Component ${second.code} (${second.name}) for Vessel ${second.vesselName}; Component ${first.code} (${first.name}) was no longer selected.`,
      ),
      async () => {
        await test.expect(second.name).not.toBe('');
        await test.expect(second.vesselName).toBe(vessel);
        await test.expect(second.code).not.toBe(first.code);
      },
    );
  },
);

/** CMP-004 verifies the real empty-tree behavior for the configured empty vessel. */
test(
  'CMP-004 - Select vessel with no equipment',
  { tag: ['@regression', '@components', '@navigation', '@positive'] },
  async () => {
    const emptyVessel = config.emptyVessel;

    await componentValidationStep(page,
      componentStep(
        `Select Vessel ${emptyVessel}`,
        `Vessel ${emptyVessel} should be selected and its vessel data should finish loading.`,
        `Vessel ${emptyVessel} was selected and its vessel-specific data finished loading.`,
      ),
      async () => {
        await componentsPage.clearComponentSearch();
        await componentsPage.selectVessel(emptyVessel);
      },
    );

    const emptyState = await componentsPage.expectEmptyVesselState(emptyVessel);
    await componentValidationStep(page,
      componentStep(
        `Validate Vessel ${emptyVessel} empty Components state`,
        `No equipment descendants or stale component details should be displayed for Vessel ${emptyVessel}.`,
        `Vessel ${emptyVessel} displayed category-only state "${emptyState}" with no equipment descendants or stale details.`,
      ),
      async () => {
        await test.expect(emptyState).not.toBe('');
      },
    );
  },
);

/** CMP-005 verifies the real Components state after a browser refresh. */
test(
  'CMP-005 - Refresh after selecting component and expanding branches',
  { tag: ['@regression', '@components', '@navigation', '@positive'] },
  async () => {
    const vessel = config.vesselA;
    const componentCode = config.componentCode;

    await componentValidationStep(page,
      componentStep(
        `Select Vessel ${vessel}`,
        `Vessel ${vessel} should be selected and its Components tree should load successfully.`,
        `Vessel ${vessel} was selected and its Components tree loaded successfully.`,
      ),
      async () => {
        await componentsPage.clearComponentSearch();
        await componentsPage.selectVessel(vessel);
        await componentsPage.expectTreeLoaded();
      },
    );
    const beforeRefresh = await componentValidationStep(page,
      componentStep(
        `Select Component ${componentCode} before refresh`,
        `Component ${componentCode} should be revealed through required branches and selected.`,
        `Component ${componentCode} was selected with accurate details.`,
      ),
      async () => componentsPage.searchAndSelectComponentByCode(componentCode),
    );

    await componentValidationStep(page,
      componentStep(
        `Refresh Vessel ${vessel} and validate Component ${beforeRefresh.code} (${beforeRefresh.name})`,
        `Refresh should return a functional Vessel ${vessel} tree with accurate data for Component ${beforeRefresh.code} (${beforeRefresh.name}).`,
        `Vessel ${vessel} refreshed without stale nodes and Component ${beforeRefresh.code} (${beforeRefresh.name}) retained accurate data.`,
      ),
      async () => {
        await page.reload();
        await componentsPage.expectToBeOnPage();
        await componentsPage.expectVesselSelected(vessel);
        await componentsPage.expectTreeLoaded();
        const afterRefresh = await componentsPage.selectedComponentIsVisible(componentCode)
          ? await componentsPage.readSelectedComponentIdentity()
          : await componentsPage.searchAndSelectComponentByCode(componentCode);
        await test.expect(afterRefresh).toEqual(beforeRefresh);
      },
    );
  },
);

/** CMP-006 verifies normal PMS navigation away from and back to Components. */
test(
  'CMP-006 - Navigate away and return to Components',
  { tag: ['@regression', '@components', '@navigation', '@positive'] },
  async () => {
    const vessel = config.vesselA;
    const componentCode = config.componentCode;

    await componentValidationStep(page,
      componentStep(
        `Select Vessel ${vessel}`,
        `Vessel ${vessel} should be selected and its Components tree should load successfully.`,
        `Vessel ${vessel} was selected and its Components tree loaded successfully.`,
      ),
      async () => {
        await componentsPage.clearComponentSearch();
        await componentsPage.selectVessel(vessel);
        await componentsPage.expectTreeLoaded();
      },
    );
    const beforeNavigation = await componentValidationStep(page,
      componentStep(
        `Select Component ${componentCode}`,
        `Component ${componentCode} should be selected before navigating away.`,
        `Component ${componentCode} was selected with accurate details before navigating away.`,
      ),
      async () => componentsPage.searchAndSelectComponentByCode(componentCode),
    );

    await componentValidationStep(page,
      componentStep(
        `Navigate away from Component ${beforeNavigation.code} (${beforeNavigation.name}) and return`,
        `Running Hours should open and Components should reopen without another login for Vessel ${vessel}.`,
        `Running Hours opened and the same browser session returned to Components for Vessel ${vessel}.`,
      ),
      async () => {
        const technicalPage = new TechnicalPage(page);
        const runningHoursPage = await technicalPage.goToRunningHours();
        await runningHoursPage.expectToBeOnPage();
        componentsPage = await technicalPage.goToComponents();
        await componentsPage.expectToBeOnPage();
      },
    );

    await componentValidationStep(page,
      componentStep(
        `Validate Component ${beforeNavigation.code} (${beforeNavigation.name}) after returning`,
        `Vessel ${vessel} should be usable and Component ${beforeNavigation.code} (${beforeNavigation.name}) should display accurate, non-stale details.`,
        `Vessel ${vessel} loaded and Component ${beforeNavigation.code} (${beforeNavigation.name}) displayed the same correct identity after returning.`,
      ),
      async () => {
        await componentsPage.clearComponentSearch();
        await componentsPage.selectVessel(vessel);
        await componentsPage.expectTreeLoaded();
        const afterNavigation = await componentsPage.searchAndSelectComponentByCode(componentCode);
        await test.expect(afterNavigation).toEqual(beforeNavigation);
      },
    );
  },
);
});
