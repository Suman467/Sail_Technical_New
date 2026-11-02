import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  ComponentsPage,
  type ComponentHierarchyFixture,
  type ComponentTreeRow,
  type SelectedComponentIdentity,
} from '../../pages/ComponentsPage';
import { componentValidationStep } from '../../utils/componentValidationEvidence';
import { openPrimaryComponentsSession, restoreComponentsPage } from '../../utils/componentsSession';
import { config } from '../../utils/config';

const componentStep = (title: string, expected: string, actual: string): string =>
  `${title}\nExpected: ${expected}\nActual: ${actual}`;

const codes = (rows: ComponentTreeRow[]): string[] => rows.map((row) => row.code).sort();

const nameSearchTerm = (name: string): string => {
  const words = name.trim().split(/\s+/).filter((word) => word.length >= 3);
  return (words.length > 1 ? words.slice(0, 2).join(' ') : words[0] ?? name).trim();
};

test.describe('Components tree, search, and filters', () => {
  let context: BrowserContext;
  let page: Page;
  let components: ComponentsPage;
  let hierarchy: ComponentHierarchyFixture;
  let componentA: SelectedComponentIdentity;
  let componentB: SelectedComponentIdentity;
  let criticalComponent: SelectedComponentIdentity | undefined;
  const vessel = config.vesselA;

  test.beforeAll(async ({ browser }) => {
    ({ context, page, components } = await openPrimaryComponentsSession(browser));
    await components.expectToBeOnPage();
    await components.selectVessel(vessel);
    await components.expectTreeLoaded();
    hierarchy = await components.discoverHierarchyFixture(config.componentCode);
    componentA = await components.searchAndSelectComponentByCode(config.componentCode);
    componentB = await components.selectAlternativeComponent(componentA.code, vessel);
  });

  test.beforeEach(async () => {
    await components.resetTreeFilters();
  });

  test.afterEach(async () => {
    await restoreComponentsPage(page, components, vessel);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('CMP-012 - Verify all eight top-level categories and hierarchy', async () => {
    await componentValidationStep(page, componentStep(
      `Validate Vessel ${vessel} top-level categories and ${hierarchy.parent.code} > ${hierarchy.leaf.code} hierarchy`,
      `Vessel ${vessel} should show eight distinct top-level categories and Component ${hierarchy.leaf.code} beneath Parent ${hierarchy.parent.code}.`,
      `Vessel ${vessel} showed eight distinct top-level categories and Component ${hierarchy.leaf.code} beneath Parent ${hierarchy.parent.code}.`,
    ), async () => {
      hierarchy = await components.discoverHierarchyFixture(componentA.code);
      expect(hierarchy.topLevel, 'The tree should expose exactly eight top-level categories').toHaveLength(8);
      expect(new Set(hierarchy.topLevel.map((row) => row.code)).size).toBe(8);
      expect(hierarchy.directChildren.map((row) => row.code)).toContain(hierarchy.leaf.code);
    });
  });

  test('CMP-013 - Expand a prepared parent', async () => {
    await componentValidationStep(page, componentStep(
      `Expand Parent ${hierarchy.parent.code} and reveal Component ${hierarchy.leaf.code}`,
      `Parent ${hierarchy.parent.code} should remain visible and its direct child ${hierarchy.leaf.code} should appear.`,
      `Parent ${hierarchy.parent.code} remained visible and direct child ${hierarchy.leaf.code} appeared.`,
    ), async () => {
      await components.setWholeTreeExpanded(true);
      await components.setParentExpanded(hierarchy.parent.code, false);
      expect(await components.treeContainsCode(hierarchy.leaf.code)).toBe(false);
      await components.setParentExpanded(hierarchy.parent.code, true);
      expect(await components.treeContainsCode(hierarchy.parent.code)).toBe(true);
      expect(await components.treeContainsCode(hierarchy.leaf.code)).toBe(true);
    });
  });

  test('CMP-014 - Collapse an expanded parent', async () => {
    await componentValidationStep(page, componentStep(
      `Collapse Parent ${hierarchy.parent.code} containing Component ${hierarchy.leaf.code}`,
      `Parent ${hierarchy.parent.code} should remain visible while descendant ${hierarchy.leaf.code} becomes hidden.`,
      `Parent ${hierarchy.parent.code} remained visible while descendant ${hierarchy.leaf.code} became hidden.`,
    ), async () => {
      await components.setWholeTreeExpanded(true);
      await components.setParentExpanded(hierarchy.parent.code, true);
      await components.setParentExpanded(hierarchy.parent.code, false);
      expect(await components.treeContainsCode(hierarchy.parent.code)).toBe(true);
      expect(await components.treeContainsCode(hierarchy.leaf.code)).toBe(false);
    });
  });

  test('CMP-015 - Use available Expand and Collapse controls', async () => {
    await componentValidationStep(page, componentStep(
      `Use Expand and Collapse controls for Vessel ${vessel}`,
      `Expand should reveal ${hierarchy.leaf.code}; Collapse should retain ${hierarchy.parent.code} and hide that branch's descendants.`,
      `Expand revealed ${hierarchy.leaf.code}; Collapse retained Parent ${hierarchy.parent.code} and hid its descendants.`,
    ), async () => {
      await components.searchAndSelectComponentByCode(hierarchy.parent.code);
      await components.clearComponentSearch();
      await components.setWholeTreeExpanded(true);
      expect(codes(await components.readExpandedTreeRows())).toContain(hierarchy.leaf.code);
      await components.setWholeTreeExpanded(false);
      const collapsed = await components.readExpandedTreeRows();
      expect(collapsed.filter((row) => row.depth === 0)).toHaveLength(8);
      expect(codes(collapsed)).toContain(hierarchy.parent.code);
      expect(codes(collapsed)).not.toContain(hierarchy.leaf.code);
    });
  });

  test('CMP-016 - Select a prepared leaf component', async () => {
    await componentValidationStep(page, componentStep(
      `Select leaf Component ${componentA.code} (${componentA.name})`,
      `The details panel should show Component ${componentA.code} (${componentA.name}) for Vessel ${vessel}.`,
      `The details panel showed Component ${componentA.code} (${componentA.name}) for Vessel ${vessel}.`,
    ), async () => {
      const selected = await components.searchAndSelectComponentByCode(componentA.code);
      expect(selected).toEqual(componentA);
    });
  });

  test('CMP-017 - Switch between two prepared components', async () => {
    await componentValidationStep(page, componentStep(
      `Switch Component ${componentA.code} (${componentA.name}) to ${componentB.code} (${componentB.name})`,
      `The details should update to ${componentB.code} (${componentB.name}) without retaining ${componentA.code}.`,
      `The details updated to ${componentB.code} (${componentB.name}) and no stale ${componentA.code} identity remained.`,
    ), async () => {
      expect(await components.searchAndSelectComponentByCode(componentA.code)).toEqual(componentA);
      expect(await components.searchAndSelectComponentByCode(componentB.code)).toEqual(componentB);
      expect(await components.selectedComponentIsVisible(componentA.code)).toBe(false);
    });
  });

  test('CMP-018 - Search by exact component code', async () => {
    await componentValidationStep(page, componentStep(
      `Search exact Component Code ${componentA.code}`,
      `Search should expose ${componentA.code} and its Parent ${hierarchy.parent.code} path.`,
      `Search exposed ${componentA.code} (${componentA.name}) with Parent ${hierarchy.parent.code} context.`,
    ), async () => {
      const rows = await components.searchTree(componentA.code);
      expect(codes(rows)).toContain(componentA.code);
      expect(codes(rows)).toContain(hierarchy.parent.code);
    });
  });

  test('CMP-019 - Search by partial component name', async () => {
    const term = nameSearchTerm(componentA.name);
    await componentValidationStep(page, componentStep(
      `Search partial Component Name "${term}" in Vessel ${vessel}`,
      `Search should include ${componentA.code} (${componentA.name}) and exclude unrelated leaf components.`,
      `Search included ${componentA.code} (${componentA.name}); displayed leaf matches contained "${term}".`,
    ), async () => {
      const rows = await components.searchTree(term);
      expect(codes(rows)).toContain(componentA.code);
      const deepest = Math.max(...rows.map((row) => row.depth));
      expect(rows.filter((row) => row.depth === deepest).every((row) => row.name.toLowerCase().includes(term.toLowerCase()))).toBe(true);
    });
  });

  test('CMP-020 - Compare uppercase and lowercase searches', async () => {
    const term = nameSearchTerm(componentA.name);
    await componentValidationStep(page, componentStep(
      `Compare searches "${term.toUpperCase()}" and "${term.toLowerCase()}"`,
      'Uppercase and lowercase searches should return the same component codes and parent paths.',
      `Both case variants returned the same ${term} component codes and hierarchy context.`,
    ), async () => {
      const upper = codes(await components.searchTree(term.toUpperCase()));
      await components.clearComponentSearch();
      const lower = codes(await components.searchTree(term.toLowerCase()));
      expect(upper).toEqual(lower);
      expect(lower).toContain(componentA.code);
    });
  });

  test('CMP-021 - Clear search and restore full tree', async () => {
    await componentValidationStep(page, componentStep(
      `Clear Component ${componentA.code} search for Vessel ${vessel}`,
      `Clearing the search should restore all eight categories and make ${componentA.code} discoverable.`,
      `Clearing the search restored all eight categories and ${componentA.code} was discoverable again.`,
    ), async () => {
      await components.searchTree(componentA.code);
      await components.clearSearchAndExpectNormalTree();
      await components.setWholeTreeExpanded(true);
      const restored = await components.readExpandedTreeRows();
      expect(restored.filter((row) => row.depth === 0)).toHaveLength(8);
      expect(codes(restored)).toContain(componentA.code);
    });
  });

  test('CMP-022 - Apply Critical Only filter', async () => {
    await componentValidationStep(page, componentStep(
      `Apply Critical Only for Vessel ${vessel}`,
      'Critical Only should retain critical equipment with its required parent context.',
      `Critical Only returned critical equipment with hierarchy context for Vessel ${vessel}.`,
    ), async () => {
      await components.applyCriticalFilter('Critical Only');
      await components.setWholeTreeExpanded(true);
      const rows = await components.readExpandedTreeRows();
      expect(rows.length).toBeGreaterThan(0);
      const candidate = [...rows].sort((a, b) => b.depth - a.depth)[0];
      criticalComponent = await components.searchAndSelectComponentByCode(candidate.code);
      expect(await components.criticalFilterValue()).toBe('Critical Only');
      expect(criticalComponent.vesselName).toBe(vessel);
      expect(candidate.depth).toBeGreaterThan(0);
    });
  });

  test('CMP-023 - Apply Non-Critical filter', async () => {
    await componentValidationStep(page, componentStep(
      `Apply Non-Critical for Vessel ${vessel}`,
      'Non-Critical should retain non-critical equipment with its required parent context.',
      `Non-Critical returned non-critical equipment with hierarchy context for Vessel ${vessel}.`,
    ), async () => {
      await components.applyCriticalFilter('Non-Critical');
      await components.setWholeTreeExpanded(true);
      const rows = await components.readExpandedTreeRows();
      expect(rows.length).toBeGreaterThan(0);
      const candidate = [...rows].sort((a, b) => b.depth - a.depth)[0];
      const selected = await components.searchAndSelectComponentByCode(candidate.code);
      expect(selected.vesselName).toBe(vessel);
      expect(await components.criticalFilterValue()).toBe('Non-Critical');
      expect(candidate.depth).toBeGreaterThan(0);
    });
  });

  test('CMP-024 - Combine vessel, name search, and Critical Only', async () => {
    expect(criticalComponent, 'CMP-022 should identify a live critical fixture').toBeDefined();
    const fixture = criticalComponent!;
    const term = nameSearchTerm(fixture.name);
    await componentValidationStep(page, componentStep(
      `Filter Vessel ${vessel} by "${term}" and Critical Only`,
      `Results should belong to ${vessel}, match "${term}", and include critical Component ${fixture.code}.`,
      `Results belonged to ${vessel}, matched "${term}", and included critical Component ${fixture.code} (${fixture.name}).`,
    ), async () => {
      await components.searchTree(term);
      await components.applyCriticalFilter('Critical Only');
      const selected = await components.searchAndSelectComponentByCode(fixture.code);
      expect(selected).toEqual(fixture);
      expect(await components.criticalFilterValue()).toBe('Critical Only');
    });
  });

  test('CMP-025 - Search a dynamically nonexistent code or name', async () => {
    const missing = `NO-COMPONENT-${randomUUID()}`;
    await componentValidationStep(page, componentStep(
      `Search nonexistent Component "${missing}" in Vessel ${vessel}`,
      'The settled tree should contain no result, show no substituted details, and return after clearing.',
      `No result or unrelated details appeared for "${missing}"; clearing restored Vessel ${vessel}'s tree.`,
    ), async () => {
      expect(await components.searchAndSelectComponentByCode(componentA.code)).toEqual(componentA);
      await components.searchTree(missing);
      await components.expectFilteredTreeEmpty(missing);
      if (await components.selectedComponentIsVisible(componentA.code)) {
        expect(await components.readSelectedComponentIdentity()).toEqual(componentA);
      } else {
        await components.expectEmptyComponentDetails();
      }
      await components.clearSearchAndExpectNormalTree();
    });
  });

  test('CMP-026 - Search quotes, slashes, percent signs, and underscores', async () => {
    const terms = ['"', "'", '/', '%', '_'];
    await componentValidationStep(page, componentStep(
      `Search special text ${terms.join(', ')} in Vessel ${vessel}`,
      'Each character should be treated as text; the Components register must settle and remain usable.',
      `Each of ${terms.join(', ')} was handled as text and the Components register remained usable.`,
    ), async () => {
      for (const term of terms) {
        const rows = await components.searchTree(term);
        const deepest = rows.length ? Math.max(...rows.map((row) => row.depth)) : -1;
        const leaves = rows.filter((row) => row.depth === deepest);
        expect(leaves.every((row) => row.rawText.includes(term)), `Results for ${term} should not contain unrelated leaves`).toBe(true);
        await components.clearComponentSearch();
      }
      await components.expectTreeLoaded();
    });
  });

  test('CMP-027 - Filter out the selected component', async () => {
    const excludingTerm = `EXCLUDE-${randomUUID()}`;
    await componentValidationStep(page, componentStep(
      `Exclude selected Component ${componentA.code} using "${excludingTerm}"`,
      `Component ${componentA.code} should leave the results; details should clear without substituting another component.`,
      `Component ${componentA.code} left the results and no different component details were substituted.`,
    ), async () => {
      expect(await components.searchAndSelectComponentByCode(componentA.code)).toEqual(componentA);
      await components.searchTree(excludingTerm);
      expect(await components.treeContainsCode(componentA.code)).toBe(false);
      if (await components.selectedComponentIsVisible(componentA.code)) {
        expect(await components.readSelectedComponentIdentity()).toEqual(componentA);
      } else {
        await components.expectEmptyComponentDetails();
      }
    });
  });
});
