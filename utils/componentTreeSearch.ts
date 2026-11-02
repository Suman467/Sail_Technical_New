import { test, type Page } from '@playwright/test';
import type { ComponentTreeRow, ComponentsPage, SelectedComponentIdentity } from '../pages/ComponentsPage';
import { componentActionStep } from './componentValidationEvidence';

export type TreeComponentVisit = ComponentTreeRow & { identity: SelectedComponentIdentity };

export type TreeSearchResult<T> = {
  /** The first component that met the scenario condition, with the value its check returned. */
  match?: { visit: TreeComponentVisit; result: T };
  /** Every component that was clicked and inspected, in visit order. */
  visited: TreeComponentVisit[];
  /** True when the bounded search stopped before every rendered component was inspected. */
  limitReached: boolean;
  /** Maximum unique components the walk could inspect; Infinity means no limit. */
  limit: number;
  /**
   * Set when the walk ended because the tree could not be read to its end (no
   * scroll progress), so components below that point were not inspected.
   */
  incomplete?: string;
};

/** Lets a check that left the Components page put the walk back where it was. */
export type TreeWalkControl = {
  /**
   * Clears any tree search, re-expands only the ancestors of the component being
   * checked and selects it again, so the walk continues with its next row without
   * restarting the tree or revisiting completed components.
   */
  restore: () => Promise<SelectedComponentIdentity>;
};

const step = (title: string, expected: string, actual: string) => `${title}\nExpected: ${expected}\nActual: ${actual}`;

/**
 * Walks the Components tree in visible order (parent, then its children and
 * subchildren, then the next parent), clicking one component at a time. After
 * every click it waits for that component's own details, verifies the code and
 * name, and runs the scenario's check. The search stops at the first component
 * whose check returns a value. Each component is visited once, only collapsed
 * parents are expanded individually (never Expand All), and the walk is bounded.
 *
 * Components are identified by their Component Code, the identity the details
 * panel confirms after every click. Every iteration adds one new code to the
 * visited set, so the walk ends when the limit is reached or no unvisited row
 * remains; it never starts the tree again. With no limit (Infinity) the walk
 * still ends, because the tree holds a finite number of codes.
 */
export async function searchComponentTree<T>(
  page: Page,
  components: ComponentsPage,
  check: (visit: TreeComponentVisit, walk: TreeWalkControl) => Promise<T | undefined>,
  maxComponents = 200,
): Promise<TreeSearchResult<T>> {
  const visitedCodes = new Set<string>();
  const visited: TreeComponentVisit[] = [];
  // The application keeps the last search text across reloads; a leftover
  // filter would hide most of the tree, so always start from the full tree.
  await components.clearComponentSearch();
  await components.expectTreeLoaded();
  let read = await components.readTreeRowsWithCoverage();
  let rows = read.rows;
  while (visited.length < maxComponents) {
    const next = rows.find((row) => !visitedCodes.has(row.code));
    // With every readable row visited, the walk is over; when the last read could not
    // reach the end of the tree, say so instead of claiming the whole tree was covered.
    if (!next) return { visited, limitReached: false, limit: maxComponents, incomplete: read.complete ? undefined : read.reason };
    visitedCodes.add(next.code);

    // Recorded as an action step: componentValidationStep is reserved for each
    // scenario's single final validation, which the reporter shows as its result.
    const identity = await componentActionStep(
      `Select Component ${next.code} (${next.name}) in the Components tree`,
      `Clicking ${next.code} should load its own Component Details on the right side.`,
      () => components.selectTreeComponent(next),
      (observed) => `Component Details loaded Code ${observed.code}, Name ${observed.name}, Vessel ${observed.vesselName}, matching the clicked tree row.`,
      { page },
    );
    const visit = { ...next, identity };
    visited.push(visit);

    // The walk is pre-order over visible rows, so the nearest earlier visit one
    // level shallower is the parent, and so on up to the top level.
    const ancestors = () => {
      const path: string[] = [];
      let depth = next.depth;
      for (let index = visited.length - 2; index >= 0 && depth > 0; index -= 1) {
        if (visited[index].depth === depth - 1) {
          path.unshift(visited[index].code);
          depth -= 1;
        }
      }
      return path;
    };
    const restore = async () => {
      await components.clearComponentSearch();
      await components.expectTreeLoaded();
      for (const code of ancestors()) {
        if (await components.treeComponentExpansionState(code) === 'collapsed') await components.expandTreeComponent(code);
      }
      return components.selectTreeComponent(next);
    };

    const result = await check(visit, { restore });
    if (result !== undefined) return { match: { visit, result }, visited, limitReached: false, limit: maxComponents };

    // Clicking a row can itself expand it; expand only when it is still collapsed.
    if (await components.treeComponentExpansionState(next.code) === 'collapsed') {
      const before = new Set((await components.readExpandedTreeRows()).map((row) => row.code));
      // Some nodes show an expand control but have no children, so the step
      // expects only that any existing children are revealed; it never claims
      // children appeared when none did.
      read = await componentActionStep(
        `Expand Component ${next.code} to check for child components`,
        `Clicking the expand control of ${next.code} should display any child components it has beneath it.`,
        async () => {
          await components.expandTreeComponent(next.code);
          return components.readTreeRowsWithCoverage();
        },
        (after) => {
          const added = after.rows.filter((row) => !before.has(row.code)).map((row) => row.code);
          return added.length
            ? `Component ${next.code} was expanded; ${added.length} component row(s) were displayed beneath it (${added.join(', ')}).`
            : `The expand control of Component ${next.code} was clicked; no child component rows were displayed beneath it, so there were no children to check under ${next.code}.`;
        },
      );
    } else {
      read = await components.readTreeRowsWithCoverage();
    }
    rows = read.rows;
  }
  return { visited, limitReached: true, limit: maxComponents };
}

/** Records, with evidence, that no inspected component satisfied a scenario's prerequisite. */
export async function recordMissingTreePrerequisite<T>(
  page: Page,
  search: TreeSearchResult<T>,
  vessel: string,
  condition: string,
): Promise<string> {
  const limitText = Number.isFinite(search.limit) ? `the component limit of ${search.limit}` : 'no component limit';
  const coverage = search.incomplete
    ? `The search inspected ${search.visited.length} unique component(s), but ${search.incomplete}; components after that point were not inspected, so the scenario was not executed.`
    : search.limitReached
      ? `The search inspected ${search.visited.length} unique component(s) and stopped at ${limitText}; components after that point were not inspected, so the scenario was not executed.`
      : `All ${search.visited.length} accessible component(s) in the tree were inspected (${limitText}), so the scenario was not executed.`;
  const actual = `No inspected component in ${vessel} met the condition. ${coverage}`;
  await test.info().attach('Inspected components', {
    body: JSON.stringify(search.visited.map(({ code, name, identity }) => ({ code, name, detailsCode: identity.code, detailsName: identity.name })), null, 2),
    contentType: 'application/json',
  });
  await test.info().attach('Missing prerequisite evidence', {
    body: await page.screenshot({ animations: 'disabled', fullPage: true }),
    contentType: 'image/png',
  });
  await test.step(`${step('Search the Components tree for the scenario prerequisite', `At least one component in ${vessel} should meet this condition: ${condition}.`, actual)}\nStatus: NOT RUN`, async () => {});
  return actual;
}
