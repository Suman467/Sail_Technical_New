import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  ComponentsPage,
  type ComponentHierarchyFixture,
  type ComponentTreeRow,
  type SelectedComponentIdentity,
} from '../../pages/ComponentsPage';
import { componentActionStep, componentScenario, componentValidationStep } from '../../utils/componentValidationEvidence';
import { openPrimaryComponentsSession, restoreComponentsPage } from '../../utils/componentsSession';
import { config } from '../../utils/config';

/** A validation step whose Actual Result is recorded from the observed values once it completes. */
const validation = (title: string, expected: string): string =>
  `${title}\nExpected: ${expected}\nActual: Recorded after the validation completes.`;

const codes = (rows: ComponentTreeRow[]): string[] => rows.map((row) => row.code).sort();
const list = (values: string[]) => (values.length ? values.join(', ') : 'none');
const identityText = (identity: SelectedComponentIdentity) => `${identity.code} (${identity.name}) in Vessel ${identity.vesselName}`;

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

  /** Records one UI action with its observed result and a screenshot of the resulting screen. */
  const act = <T>(title: string, expected: string, body: () => Promise<T>, actual: (value: T) => string) =>
    componentActionStep(title, expected, body, actual, { page });

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

  /** Applies a Critical Item filter, opens the filtered tree and selects its deepest component. */
  const selectFilteredComponent = async (filter: 'Critical Only' | 'Non-Critical') => {
    await act(`Select Critical Item = ${filter}`, `The Critical Item filter should show ${filter} and the tree should reload.`,
      async () => { await components.applyCriticalFilter(filter); return components.criticalFilterValue(); },
      (value) => `The Critical Item filter showed "${value}".`);
    const rows = await act('Click Expand to open the filtered tree', `The ${filter} tree should open and list its components with their parents.`,
      async () => { await components.setWholeTreeExpanded(true); return components.readExpandedTreeRows(); },
      (shown) => `The ${filter} tree showed ${shown.length} row(s); the deepest level reached was ${shown.length ? Math.max(...shown.map((row) => row.depth)) + 1 : 0}.`);
    expect(rows.length, `Observed Application Result: the ${filter} tree of Vessel ${vessel} showed no rows.`).toBeGreaterThan(0);
    const candidate = [...rows].sort((first, second) => second.depth - first.depth)[0];
    const selected = await act(`Select Component ${candidate.code} from the ${filter} results`, `Component ${candidate.code} should open in the details panel of Vessel ${vessel}.`,
      async () => ({ identity: await components.searchAndSelectComponentByCode(candidate.code), filter: await components.criticalFilterValue() }),
      (state) => `Component Details showed ${identityText(state.identity)}; the Critical Item filter showed "${state.filter}".`);
    return { rows, candidate, ...selected };
  };

  test('CMP-012 - Verify all eight top-level categories and hierarchy', componentScenario(`Vessel ${vessel} should show eight distinct top-level categories, and the configured component should appear as a direct child of its parent.`), async () => {
    hierarchy = await act(`Open Component ${componentA.code} in the tree and read the top-level categories`, `The tree of Vessel ${vessel} should load its top-level categories and the branch containing ${componentA.code}.`,
      () => components.discoverHierarchyFixture(componentA.code),
      (found) => `Vessel ${vessel} showed ${found.topLevel.length} top-level categories (${list(found.topLevel.map((row) => row.code))}); ${found.leaf.code} is shown beneath Parent ${found.parent.code}, whose direct children are ${list(found.directChildren.map((row) => row.code))}.`);
    await componentValidationStep(page, validation('Verify the eight categories and the parent-child relationship', `Exactly eight distinct top-level categories should be shown, and ${hierarchy.leaf.code} should be a direct child of ${hierarchy.parent.code}.`), async () => {
      expect(hierarchy.topLevel, 'The tree should expose exactly eight top-level categories').toHaveLength(8);
      expect(new Set(hierarchy.topLevel.map((row) => row.code)).size).toBe(8);
      expect(hierarchy.directChildren.map((row) => row.code)).toContain(hierarchy.leaf.code);
    }, { actual: () => `Vessel ${vessel} showed eight distinct top-level categories (${list(hierarchy.topLevel.map((row) => row.code))}) and ${hierarchy.leaf.code} directly beneath Parent ${hierarchy.parent.code}.` });
  });

  test('CMP-013 - Expand a prepared parent', componentScenario('Expanding a collapsed parent should keep the parent visible and show its direct child.'), async () => {
    const { parent, leaf } = hierarchy;
    await act('Click Expand to open the whole tree', `The tree of Vessel ${vessel} should open every branch.`,
      () => components.setWholeTreeExpanded(true), () => `The tree of Vessel ${vessel} was expanded.`);
    const collapsed = await act(`Collapse Parent ${parent.code}`, `Parent ${parent.code} should close and hide its child ${leaf.code}.`,
      async () => { await components.setParentExpanded(parent.code, false); return components.treeContainsCode(leaf.code); },
      (leafShown) => `Parent ${parent.code} was collapsed; child ${leaf.code} was ${leafShown ? 'still shown' : 'hidden'}.`);
    expect(collapsed, `Observed Application Result: child ${leaf.code} remained visible after Parent ${parent.code} was collapsed.`).toBe(false);
    const expanded = await act(`Expand Parent ${parent.code}`, `Parent ${parent.code} should open and show its child ${leaf.code}.`,
      async () => { await components.setParentExpanded(parent.code, true); return { parent: await components.treeContainsCode(parent.code), leaf: await components.treeContainsCode(leaf.code) }; },
      (state) => `Parent ${parent.code} was ${state.parent ? 'shown' : 'not shown'} and child ${leaf.code} was ${state.leaf ? 'shown' : 'not shown'}.`);
    await componentValidationStep(page, validation(`Verify Parent ${parent.code} shows child ${leaf.code}`, `Parent ${parent.code} should remain visible and its direct child ${leaf.code} should appear.`), async () => {
      expect(expanded.parent).toBe(true);
      expect(expanded.leaf).toBe(true);
    }, { actual: () => `Parent ${parent.code} remained visible and direct child ${leaf.code} appeared.` });
  });

  test('CMP-014 - Collapse an expanded parent', componentScenario('Collapsing an expanded parent should keep the parent visible and hide its descendants.'), async () => {
    const { parent, leaf } = hierarchy;
    await act('Click Expand to open the whole tree', `The tree of Vessel ${vessel} should open every branch.`,
      () => components.setWholeTreeExpanded(true), () => `The tree of Vessel ${vessel} was expanded.`);
    await act(`Make sure Parent ${parent.code} is expanded`, `Parent ${parent.code} should be open and show child ${leaf.code}.`,
      async () => { await components.setParentExpanded(parent.code, true); return components.treeContainsCode(leaf.code); },
      (leafShown) => `Parent ${parent.code} was open; child ${leaf.code} was ${leafShown ? 'shown' : 'not shown'}.`);
    const collapsed = await act(`Collapse Parent ${parent.code}`, `Parent ${parent.code} should close and hide child ${leaf.code}.`,
      async () => { await components.setParentExpanded(parent.code, false); return { parent: await components.treeContainsCode(parent.code), leaf: await components.treeContainsCode(leaf.code) }; },
      (state) => `Parent ${parent.code} was ${state.parent ? 'still shown' : 'not shown'}; child ${leaf.code} was ${state.leaf ? 'still shown' : 'hidden'}.`);
    await componentValidationStep(page, validation(`Verify Parent ${parent.code} stays visible and ${leaf.code} is hidden`, `Parent ${parent.code} should remain visible while descendant ${leaf.code} becomes hidden.`), async () => {
      expect(collapsed.parent).toBe(true);
      expect(collapsed.leaf).toBe(false);
    }, { actual: () => `Parent ${parent.code} remained visible and descendant ${leaf.code} was hidden.` });
  });

  test('CMP-015 - Use available Expand and Collapse controls', componentScenario('The register Expand control should show deeper components, and Collapse should return to the eight top-level categories while keeping parents reachable.'), async () => {
    const { parent, leaf } = hierarchy;
    await act(`Select Component ${parent.code} and clear the search`, `Component ${parent.code} should open, and clearing the search should show the full tree of Vessel ${vessel}.`,
      async () => { const identity = await components.searchAndSelectComponentByCode(parent.code); await components.clearComponentSearch(); return identity; },
      (identity) => `Component Details showed ${identityText(identity)}; the search box was cleared.`);
    const expanded = await act('Click Expand', `The tree should open and include ${leaf.code}.`,
      async () => { await components.setWholeTreeExpanded(true); return components.readExpandedTreeRows(); },
      (rows) => `After Expand the tree showed ${rows.length} row(s); ${leaf.code} was ${codes(rows).includes(leaf.code) ? 'shown' : 'not shown'}.`);
    const collapsed = await act('Click Collapse', 'The tree should close to its top-level categories while keeping the branch to the selected parent.',
      async () => { await components.setWholeTreeExpanded(false); return components.readExpandedTreeRows(); },
      (rows) => `After Collapse the tree showed ${rows.filter((row) => row.depth === 0).length} top-level categories; ${parent.code} was ${codes(rows).includes(parent.code) ? 'shown' : 'not shown'} and ${leaf.code} was ${codes(rows).includes(leaf.code) ? 'shown' : 'hidden'}.`);
    await componentValidationStep(page, validation('Verify Expand and Collapse results', `Expand should reveal ${leaf.code}; Collapse should keep eight categories and ${parent.code} visible and hide ${leaf.code}.`), async () => {
      expect(codes(expanded)).toContain(leaf.code);
      expect(collapsed.filter((row) => row.depth === 0)).toHaveLength(8);
      expect(codes(collapsed)).toContain(parent.code);
      expect(codes(collapsed)).not.toContain(leaf.code);
    }, { actual: () => `Expand revealed ${leaf.code}; Collapse kept eight top-level categories and ${parent.code}, and hid ${leaf.code}.` });
  });

  test('CMP-016 - Select a prepared leaf component', componentScenario('Selecting a leaf component should show that component\'s own code, name, and vessel in the details panel.'), async () => {
    const selected = await act(`Search and select leaf Component ${componentA.code}`, `Component ${componentA.code} should open in the details panel.`,
      () => components.searchAndSelectComponentByCode(componentA.code), (identity) => `Component Details showed ${identityText(identity)}.`);
    await componentValidationStep(page, validation(`Verify the details panel shows Component ${componentA.code}`, `The details panel should show Component ${componentA.code} (${componentA.name}) for Vessel ${vessel}.`), async () => {
      expect(selected).toEqual(componentA);
    }, { actual: () => `The details panel showed ${identityText(selected)}.` });
  });

  test('CMP-017 - Switch between two prepared components', componentScenario('Selecting a second component should replace the first component\'s details completely.'), async () => {
    const first = await act(`Select Component ${componentA.code}`, `Component ${componentA.code} should open in the details panel.`,
      () => components.searchAndSelectComponentByCode(componentA.code), (identity) => `Component Details showed ${identityText(identity)}.`);
    const second = await act(`Select Component ${componentB.code}`, `The details panel should switch to Component ${componentB.code}.`,
      async () => ({ identity: await components.searchAndSelectComponentByCode(componentB.code), staleFirst: await components.selectedComponentIsVisible(componentA.code) }),
      (state) => `Component Details showed ${identityText(state.identity)}; Component ${componentA.code} was ${state.staleFirst ? 'still shown' : 'no longer shown'}.`);
    await componentValidationStep(page, validation(`Verify the details switched to ${componentB.code}`, `The details should update to ${componentB.code} (${componentB.name}) without retaining ${componentA.code}.`), async () => {
      expect(first).toEqual(componentA);
      expect(second.identity).toEqual(componentB);
      expect(second.staleFirst).toBe(false);
    }, { actual: () => `The details updated from ${componentA.code} to ${identityText(second.identity)} and no ${componentA.code} details remained.` });
  });

  test('CMP-018 - Search by exact component code', componentScenario('Searching an exact component code should show that component together with its parent path.'), async () => {
    const rows = await act(`Search for Component Code ${componentA.code}`, `The tree should show ${componentA.code} and the parents leading to it.`,
      () => components.searchTree(componentA.code), (shown) => `The search showed ${shown.length} row(s): ${list(shown.map((row) => row.code))}.`);
    await componentValidationStep(page, validation(`Verify ${componentA.code} and Parent ${hierarchy.parent.code} are in the results`, `The results should include ${componentA.code} and its Parent ${hierarchy.parent.code}.`), async () => {
      expect(codes(rows)).toContain(componentA.code);
      expect(codes(rows)).toContain(hierarchy.parent.code);
    }, { actual: () => `The results included ${componentA.code} (${componentA.name}) and its Parent ${hierarchy.parent.code}.` });
  });

  test('CMP-019 - Search by partial component name', componentScenario('Searching part of a component name should include that component and show only matching components at the deepest level.'), async () => {
    const term = nameSearchTerm(componentA.name);
    const rows = await act(`Search for "${term}"`, `The tree should show components whose name contains "${term}", with their parents.`,
      () => components.searchTree(term), (shown) => `The search showed ${shown.length} row(s): ${list(shown.map((row) => row.code))}.`);
    const deepest = rows.length ? Math.max(...rows.map((row) => row.depth)) : -1;
    const leaves = rows.filter((row) => row.depth === deepest);
    await componentValidationStep(page, validation(`Verify the results for "${term}"`, `The results should include ${componentA.code} (${componentA.name}), and every deepest-level result should contain "${term}".`), async () => {
      expect(codes(rows)).toContain(componentA.code);
      expect(leaves.filter((row) => !row.name.toLowerCase().includes(term.toLowerCase())).map((row) => `${row.code} ${row.name}`), 'Deepest-level results that do not contain the search term').toEqual([]);
    }, { actual: () => `The results included ${componentA.code}; all ${leaves.length} deepest-level result(s) (${list(leaves.map((row) => row.code))}) contained "${term}".` });
  });

  test('CMP-020 - Compare uppercase and lowercase searches', componentScenario('Searching the same text in uppercase and lowercase should return the same components.'), async () => {
    const term = nameSearchTerm(componentA.name);
    const upper = await act(`Search for "${term.toUpperCase()}"`, 'The tree should show the components matching the uppercase text.',
      async () => codes(await components.searchTree(term.toUpperCase())), (found) => `The uppercase search showed ${found.length} row(s): ${list(found)}.`);
    await act('Clear the search', 'The search box should be empty and the full tree should return.',
      () => components.clearComponentSearch(), () => 'The search box was cleared and the tree reloaded.');
    const lower = await act(`Search for "${term.toLowerCase()}"`, 'The tree should show the components matching the lowercase text.',
      async () => codes(await components.searchTree(term.toLowerCase())), (found) => `The lowercase search showed ${found.length} row(s): ${list(found)}.`);
    await componentValidationStep(page, validation('Verify both searches returned the same components', `Both searches should return the same rows, including ${componentA.code}.`), async () => {
      expect(upper).toEqual(lower);
      expect(lower).toContain(componentA.code);
    }, { actual: () => `Both searches returned the same ${lower.length} row(s), including ${componentA.code}.` });
  });

  test('CMP-021 - Clear search and restore full tree', componentScenario('Clearing a search should restore all eight categories and make the searched component reachable again.'), async () => {
    await act(`Search for Component Code ${componentA.code}`, `The tree should be narrowed to ${componentA.code} and its parents.`,
      () => components.searchTree(componentA.code), (shown) => `The search showed ${shown.length} row(s): ${list(shown.map((row) => row.code))}.`);
    await act('Clear the search', 'The search box should be empty and the full tree should return.',
      () => components.clearSearchAndExpectNormalTree(), () => 'The search box was cleared and the full tree loaded.');
    const restored = await act('Click Expand', `The full tree should open and include ${componentA.code}.`,
      async () => { await components.setWholeTreeExpanded(true); return components.readExpandedTreeRows(); },
      (rows) => `The tree showed ${rows.filter((row) => row.depth === 0).length} top-level categories and ${rows.length} row(s); ${componentA.code} was ${codes(rows).includes(componentA.code) ? 'shown' : 'not shown'}.`);
    await componentValidationStep(page, validation('Verify the full tree was restored', `Eight top-level categories should be shown and ${componentA.code} should be reachable.`), async () => {
      expect(restored.filter((row) => row.depth === 0)).toHaveLength(8);
      expect(codes(restored)).toContain(componentA.code);
    }, { actual: () => `The full tree showed eight top-level categories and ${componentA.code} was reachable again.` });
  });

  test('CMP-022 - Apply Critical Only filter', componentScenario('The Critical Only filter should show critical components of the vessel together with the parents needed to reach them.'), async () => {
    const result = await selectFilteredComponent('Critical Only');
    criticalComponent = result.identity;
    await componentValidationStep(page, validation('Verify the Critical Only results', `The filter should stay Critical Only and a component below the top level should belong to Vessel ${vessel}.`), async () => {
      expect(result.filter).toBe('Critical Only');
      expect(result.identity.vesselName).toBe(vessel);
      expect(result.candidate.depth).toBeGreaterThan(0);
    }, { actual: () => `With Critical Only applied, ${identityText(result.identity)} was shown at level ${result.candidate.depth + 1}, beneath its parents.` });
  });

  test('CMP-023 - Apply Non-Critical filter', componentScenario('The Non-Critical filter should show non-critical components of the vessel together with the parents needed to reach them.'), async () => {
    const result = await selectFilteredComponent('Non-Critical');
    await componentValidationStep(page, validation('Verify the Non-Critical results', `The filter should stay Non-Critical and a component below the top level should belong to Vessel ${vessel}.`), async () => {
      expect(result.filter).toBe('Non-Critical');
      expect(result.identity.vesselName).toBe(vessel);
      expect(result.candidate.depth).toBeGreaterThan(0);
    }, { actual: () => `With Non-Critical applied, ${identityText(result.identity)} was shown at level ${result.candidate.depth + 1}, beneath its parents.` });
  });

  test('CMP-024 - Combine vessel, name search, and Critical Only', componentScenario('A name search combined with Critical Only should keep both the search text and the filter, and show the matching critical component of the vessel.'), async () => {
    // CMP-022 normally supplies the critical component; a run of CMP-024 alone finds one the same way.
    if (!criticalComponent) {
      criticalComponent = (await selectFilteredComponent('Critical Only')).identity;
      await act('Reset the search and Critical Item filter', 'The search should be empty and Critical Item should return to All Items before the combined search.',
        async () => { await components.resetTreeFilters(); return components.criticalFilterValue(); }, (value) => `The search was cleared and Critical Item showed "${value}".`);
    }
    const fixture = criticalComponent;
    const term = nameSearchTerm(fixture.name);
    await act(`Search for "${term}"`, `The tree of Vessel ${vessel} should show components whose name contains "${term}".`,
      () => components.searchTree(term), (shown) => `The search showed ${shown.length} row(s): ${list(shown.map((row) => row.code))}.`);
    const filtered = await act('Select Critical Item = Critical Only', `The filter should show Critical Only and the search box should still hold "${term}".`,
      async () => { await components.applyCriticalFilter('Critical Only'); return { filter: await components.criticalFilterValue(), search: await components.componentSearchText() }; },
      (state) => `The Critical Item filter showed "${state.filter}" and the search box held "${state.search}".`);
    const rows = await act('Click Expand to open the combined results', `The results should include critical Component ${fixture.code}.`,
      async () => { await components.setWholeTreeExpanded(true); return components.readExpandedTreeRows(); },
      (shown) => `The combined results showed ${shown.length} row(s): ${list(shown.map((row) => row.code))}.`);
    const selected = await act(`Select Component ${fixture.code} from the combined results`, `Component ${fixture.code} should open in the details panel without changing the search or filter.`,
      async () => {
        await components.selectComponentByCode(fixture.code);
        return { identity: await components.readSelectedComponentIdentity(), filter: await components.criticalFilterValue(), search: await components.componentSearchText() };
      },
      (state) => `Component Details showed ${identityText(state.identity)}; the filter showed "${state.filter}" and the search box held "${state.search}".`);
    await componentValidationStep(page, validation('Verify the combined search and filter results', `Results should belong to ${vessel}, match "${term}", stay filtered to Critical Only, and include critical Component ${fixture.code}.`), async () => {
      expect(filtered.filter).toBe('Critical Only');
      expect(codes(rows)).toContain(fixture.code);
      expect(selected.identity).toEqual(fixture);
      expect(selected.filter).toBe('Critical Only');
      expect(selected.search).toBe(term);
    }, { actual: () => `With search "${term}" and Critical Only applied, the results included ${identityText(selected.identity)}; the filter remained Critical Only and the search remained "${term}".` });
  });

  test('CMP-025 - Search a dynamically nonexistent code or name', componentScenario('Searching text that matches no component should show no results and no other component\'s details, and clearing the search should restore the tree.'), async () => {
    const missing = `NO-COMPONENT-${randomUUID()}`;
    await act(`Select Component ${componentA.code}`, `Component ${componentA.code} should open in the details panel.`,
      () => components.searchAndSelectComponentByCode(componentA.code), (identity) => `Component Details showed ${identityText(identity)}.`);
    await act(`Search for "${missing}"`, 'The tree should show no matching component.',
      () => components.searchTree(missing).then(async () => components.expectFilteredTreeEmpty(missing)), () => `The search for "${missing}" showed no component rows.`);
    const details = await act('Read the details panel', `The details panel should either keep ${componentA.code} or show no component; it should not show a different component.`,
      async () => (await components.selectedComponentIsVisible(componentA.code) ? components.readSelectedComponentIdentity() : undefined),
      (identity) => (identity ? `The details panel still showed ${identityText(identity)}.` : 'The details panel showed no component.'));
    if (!details) await components.expectEmptyComponentDetails();
    await act('Clear the search', 'The full tree should return.', () => components.clearSearchAndExpectNormalTree(), () => 'The search box was cleared and the full tree loaded.');
    await componentValidationStep(page, validation('Verify no unrelated component was shown', `No result should appear for "${missing}" and no other component's details should be substituted.`), async () => {
      if (details) expect(details).toEqual(componentA);
    }, { actual: () => `No result appeared for "${missing}"; the details panel ${details ? `kept ${componentA.code}` : 'showed no component'}; clearing the search restored the tree of Vessel ${vessel}.` });
  });

  test('CMP-026 - Search quotes, slashes, percent signs, and underscores', componentScenario('Special characters in the search should be treated as plain text, and the register should remain usable.'), async () => {
    const terms = ['"', "'", '/', '%', '_'];
    const unrelated: string[] = [];
    for (const term of terms) {
      const rows = await act(`Search for ${term}`, `The tree should show only components whose text contains ${term}.`,
        () => components.searchTree(term), (shown) => `The search for ${term} showed ${shown.length} row(s).`);
      const deepest = rows.length ? Math.max(...rows.map((row) => row.depth)) : -1;
      unrelated.push(...rows.filter((row) => row.depth === deepest && !row.rawText.includes(term)).map((row) => `${term}: ${row.code}`));
      await act('Clear the search', 'The full tree should return.', () => components.clearComponentSearch(), () => 'The search box was cleared and the tree reloaded.');
    }
    await componentValidationStep(page, validation('Verify each character was treated as text', 'No search should return a deepest-level component that does not contain the searched character, and the register should remain usable.'), async () => {
      expect(unrelated, 'Deepest-level results that do not contain the searched character').toEqual([]);
      await components.expectTreeLoaded();
    }, { actual: () => `Each of ${terms.join(' ')} returned only matching components, and the register remained usable.` });
  });

  test('CMP-027 - Filter out the selected component', componentScenario('A search that excludes the selected component should remove it from the results without showing another component\'s details.'), async () => {
    const excludingTerm = `EXCLUDE-${randomUUID()}`;
    await act(`Select Component ${componentA.code}`, `Component ${componentA.code} should open in the details panel.`,
      () => components.searchAndSelectComponentByCode(componentA.code), (identity) => `Component Details showed ${identityText(identity)}.`);
    const stillListed = await act(`Search for "${excludingTerm}"`, `The results should no longer include ${componentA.code}.`,
      async () => { await components.searchTree(excludingTerm); return components.treeContainsCode(componentA.code); },
      (listed) => `Component ${componentA.code} was ${listed ? 'still listed' : 'no longer listed'} in the results.`);
    const details = await act('Read the details panel', `The details panel should either keep ${componentA.code} or show no component; it should not show a different component.`,
      async () => (await components.selectedComponentIsVisible(componentA.code) ? components.readSelectedComponentIdentity() : undefined),
      (identity) => (identity ? `The details panel still showed ${identityText(identity)}.` : 'The details panel showed no component.'));
    if (!details) await components.expectEmptyComponentDetails();
    await componentValidationStep(page, validation(`Verify ${componentA.code} left the results`, `Component ${componentA.code} should leave the results and no other component's details should be substituted.`), async () => {
      expect(stillListed).toBe(false);
      if (details) expect(details).toEqual(componentA);
    }, { actual: () => `Component ${componentA.code} left the results and the details panel ${details ? `kept ${componentA.code}` : 'showed no component'}.` });
  });
});
