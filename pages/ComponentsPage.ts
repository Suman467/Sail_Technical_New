/* global document, Element, HTMLElement, requestAnimationFrame */

import { expect, type Locator, type Page, type Response } from '@playwright/test';
import { readAppNotification } from '../utils/appNotification';
import { config } from '../utils/config';
import { routes } from '../utils/routes';
import { BasePage } from './BasePage';
import { ComponentFormPage } from './ComponentFormPage';
import { JobFormPage } from './JobFormPage';

export type ComponentTreeRow = {
  code: string;
  name: string;
  depth: number;
  rawText: string;
};

/** Tree rows read from top to bottom; `reason` explains a read that could not reach the end of the tree. */
export type TreeRowsRead = { rows: ComponentTreeRow[]; complete: boolean; reason?: string };

export type AutomationLookingComponent = {
  code: string;
  name: string;
  parentCode: string;
};

export type ComponentDetailField = {
  section: string;
  label: string;
};

export type SelectedComponentIdentity = {
  code: string;
  name: string;
  vesselName: string;
};

export class ComponentNotFoundDuringDeletionError extends Error {
  public constructor(public readonly feedback: string) {
    super(feedback);
    this.name = 'ComponentNotFoundDuringDeletionError';
  }
}

/** Matches the linked-jobs message for any job count (1, 6, 100, …). */
const LINKED_JOBS_MESSAGE = /This component cannot be deleted because it has \d+ active Job\(s\) linked to it/i;

export class ComponentBlockedByLinkedJobsError extends Error {
  public constructor(
    /** The complete popup message exactly as displayed, including the job count. */
    public readonly popupMessage: string,
    /** The active job count shown in the popup, or undefined if it could not be read. */
    public readonly linkedJobCount: number | undefined,
  ) {
    super(`Cannot Delete Component — ${popupMessage} The popup was acknowledged with OK and the Components register was refreshed.`);
    this.name = 'ComponentBlockedByLinkedJobsError';
  }
}

export type ComponentJobRow = {
  jobCode: string;
  jobTitle: string;
  frequency: string;
  lastDoneDate: string;
  lastDoneHour: string;
};

export type GeneratedWorkOrderResult = {
  jobCode: string;
  reason: string;
  httpStatus: number;
  feedback: string;
  responseBody: string;
  workOrderNumber: string;
  status: string;
};

export type ComponentSpareRow = {
  partCode: string;
  partName: string;
  componentName: string;
  partNumber: string;
  rob: string;
  min: string;
  stock: string;
  location: string;
};

export type SpareListState = { spares: ComponentSpareRow[]; emptyMessage: string };
export type SpareListView = { label: string; scope: Locator; list: Locator; mode: 'inline' | 'dialog' };
export type SparePageState = { label: string; currentPage: number; totalPages: number; spares: ComponentSpareRow[] };
export type SpareDetailsState = { spare: ComponentSpareRow; dialog: Locator; linkedComponentTexts: string[] };
/** A linked spare and the F. Spares page (1-based; 0 when the list is not paginated) where it was found. */
export type DiscoveredSpare = ComponentSpareRow & { page: number };
export type LinkedSpareInventory = {
  spares: DiscoveredSpare[];
  /** Rows read across every page, including repeated rows, before de-duplication. */
  rowsRead: number;
  totalPages: number;
  pageLabels: string[];
};
/** Values read from the Spare Part Details popup; "-" placeholders are returned as empty strings. */
export type SparePartDetails = {
  dialog: Locator;
  title: string;
  partCode: string;
  partName: string;
  linkedComponentsShown: boolean;
  linkedCount?: number;
  linkedComponentTexts: string[];
  stockSectionShown: boolean;
  totalRob: string;
  minimumLevel: string;
  stockStatus: string;
};

export type SpareGridSnapshot = {
  headers: { colId: string; colIndex: string; position: number; text: string }[];
  rows: { rowId: string; domIndex: number; cells: { colId: string; colIndex: string; position: number; text: string; title: string }[] }[];
};
export type SpareLocationBreakdown = {
  spare: ComponentSpareRow;
  viewLabel: string;
  locations: { location: string; quantity: string }[];
  totalRob: string;
};

export type SpareWithLocationView = DiscoveredSpare & { viewLabel: string };

export type ComponentAbsenceSearchResult = {
  searchTerm: string;
  visibleResultCount: number;
  exactComponentMatches: number;
  feedback: string;
};

export type ComponentHierarchyFixture = {
  parent: ComponentTreeRow;
  leaf: ComponentTreeRow;
  directChildren: ComponentTreeRow[];
  topLevel: ComponentTreeRow[];
};

/**
 * Models the Components list page in the Technical module.
 */
export class ComponentsPage extends BasePage {
  protected readonly path = routes.componentPage;
  protected readonly pageName = 'Components';
  protected readonly pageLoadedIndicator: Locator;

  private readonly vesselDropdown: Locator;
  private readonly componentSearchField: Locator;
  private readonly componentCountLabel: Locator;
  private readonly componentRows: Locator;
  private readonly componentDetailsArea: Locator;
  private readonly expandAllButton: Locator;
  private selectedComponentCode = '';
  private readonly componentsWithExpandedJobs = new Set<string>();
  private readonly componentsWithExpandedSpares = new Set<string>();
  private readonly jobsByComponent = new Map<string, ComponentJobRow[]>();
  private readonly sparesByComponent = new Map<string, ComponentSpareRow[]>();

  /**
   * What this does: Creates the Components page object and collects the key selectors used on that screen.
   * When it's used: When a test needs to work with the components list.
   * @param page - The Playwright page instance for the Components screen.
   * @returns True only when the UI actually changed the vessel selection.
   */
  public constructor(page: Page) {
    super(page);

    this.pageLoadedIndicator = page.getByRole('heading', {
      name: 'Components',
      exact: true,
    });

    this.vesselDropdown = page.getByRole('combobox').first();

    this.componentSearchField = page.getByPlaceholder(
      'Search by Name, SFI Code, Fleet Equipment Code, Maker, or Se...',
    );

    this.componentCountLabel = page.getByText('COMPONENTS', {
      exact: true,
    });
    this.expandAllButton = page.getByRole('button', { name: 'Expand', exact: true });
    this.componentDetailsArea = page
      .getByText('Select a component to view details', { exact: true })
      .locator('..');

    /*
     * All component rows use the same row structure.
     *
     * Example:
     * 1 Ship General
     * 2 Hull
     * 3 Equipment for Cargo
     *
     * We intentionally do not use the styling class of the
     * component name span because that class can be shared
     * by other elements.
     */
    this.componentRows = page.getByTestId('B6').locator(
      'div.flex.items-center.px-3.py-2.cursor-pointer',
    );
  }

  /**
   * What this does: Reads the visible count shown for the current component list.
   * When it's used: To compare the page count against the actual row count in assertions.
   * @returns The count shown on the screen, or the row count if the label is not readable.
   */
  public async displayedCount(): Promise<number> {
    const countText = await this.componentCountLabel
      .locator('..')
      .innerText();

    return Number(
      countText.match(/\d+/)?.[0] ?? (await this.rowCount()),
    );
  }

  /**
   * What this does: Counts how many component rows are currently visible in the list.
   * When it's used: When comparing the list total to the header count.
   * @returns The number of rows currently rendered.
   */
  public async rowCount(): Promise<number> {
    return this.componentRows.count();
  }

  /**
   * Expands the complete Components hierarchy and keeps the
   * component selection behavior used by the application.
   *
   * Each component is clicked only once when it is discovered.
   * A component with a right-chevron is expanded by clicking its
   * component text. The same click also keeps the component selected,
   * so the existing details panel behavior is preserved.
   *
   * The DOM is re-read after every click because expanding a parent
   * inserts its children and changes the rendered row list.
   */
  public async expandAll(): Promise<void> {
    await expect(this.expandAllButton).toBeVisible();
    await this.expandAllButton.click();
    await expect(this.componentRows.first()).toBeVisible();
    await expect(this.page.getByTestId('B6').locator('[aria-busy="true"]')).toHaveCount(0);
  }

  /** Expands the currently rendered chevron levels without inferring hierarchy from styling. */
  public async expandTreeLevels(levels = 3): Promise<void> {
    const attemptedCodes = new Set<string>();
    for (let level = 0; level < levels; level += 1) {
      const collapsedRows = this.componentRows.filter({
        has: this.page.locator('svg.lucide-chevron-right'),
      });
      const codes = (await collapsedRows.allInnerTexts())
        .map((text) => text.replace(/\s+/g, ' ').trim().split(' ')[0])
        .filter((code) => Boolean(code) && !attemptedCodes.has(code));
      if (!codes.length) return;
      for (const code of codes) {
        attemptedCodes.add(code);
        const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const row = this.componentRows.filter({ hasText: new RegExp(`^${escaped}(?:\\s|$)`) }).first();
        if (await row.locator('svg.lucide-chevron-right').isVisible().catch(() => false)) {
          await row.getByRole('button').first().click();
          await expect(this.page.getByTestId('B6').locator('[aria-busy="true"]')).toHaveCount(0);
        }
      }
    }
  }

  /**
   * Reads all component tree rows from the rendered UI,
   * including their visual nesting depth.
   *
   * No application API is called.
   */
  public async readExpandedTreeRows(): Promise<ComponentTreeRow[]> {
    return (await this.readTreeRowsWithCoverage()).rows;
  }

  /**
   * Reads every rendered tree row from the top of the virtualized tree to its end.
   * Each scroll step must move past the furthest position already read, so the
   * read ends at the bottom of the tree or reports where it stopped making
   * progress; it never re-reads the same positions indefinitely.
   */
  public async readTreeRowsWithCoverage(): Promise<TreeRowsRead> {
    const rowsByCode = new Map<
      string,
      {
        code: string;
        name: string;
        left: number;
        rawText: string;
      }
    >();

    /*
     * The caller is responsible for expanding the hierarchy.
     * Do not call expandAll() here because the scenario already
     * expands the tree before reading it. Calling it again creates
     * a second full traversal of the hierarchy.
     */
    // Always start at the top: rows above the current scroll position (and the
    // indentation levels they define, which give every row its depth) must be included.
    await this.setComponentTreeScrollTop(0);
    await this.page.waitForTimeout(100);
    let furthest = -1;
    let incomplete: string | undefined;
    for (;;) {
      const snapshot = await this.page.evaluate(() => {
        const selector =
          'div.flex.items-center.px-3.py-2.cursor-pointer';

        const elements = Array.from(
          document.querySelectorAll<HTMLElement>(selector),
        );

        const rows = elements
          .map((element) => {
            const rawText = element.innerText
              .replace(/\s+/g, ' ')
              .trim();

            const match = rawText.match(/^([A-Z0-9][A-Z0-9.-]*)\s+(.+)$/i);

            return match
              ? {
                  code: match[1],
                  name: match[2].trim(),
                  left: Math.round(
                    (element.querySelector('button') ?? element)
                      .getBoundingClientRect().left,
                  ),
                  rawText,
                }
              : null;
          })
          .filter(
            (
              row,
            ): row is {
              code: string;
              name: string;
              left: number;
              rawText: string;
            } => Boolean(row),
          );

        /*
         * Find the scrollable parent containing the component tree.
         */
        let scroller: HTMLElement | null =
          elements[0]?.parentElement ?? null;

        while (scroller && scroller !== document.body) {
          if (
            scroller.scrollHeight >
            scroller.clientHeight + 1
          ) {
            break;
          }

          scroller = scroller.parentElement;
        }

        if (!scroller || scroller === document.body) {
          scroller = null;
        }

        return {
          rows,
          scrollTop: scroller?.scrollTop ?? 0,
          clientHeight: scroller?.clientHeight ?? 0,
          scrollHeight: scroller?.scrollHeight ?? 0,
          hasScroller: Boolean(scroller),
        };
      });

      /*
       * Store every row by component code.
       */
      for (const row of snapshot.rows) {
        rowsByCode.set(row.code, row);
      }

      /*
       * A rerender that returned the list to an earlier position means the rows
       * just scrolled to were not the ones read; stop instead of repeating.
       */
      if (snapshot.hasScroller && snapshot.scrollTop < furthest) {
        incomplete = `the component tree returned from scroll position ${Math.round(furthest)} to ${Math.round(snapshot.scrollTop)} px while it was being read, so rows below position ${Math.round(furthest)} could not be read reliably`;
        break;
      }

      /*
       * Stop when we have reached the bottom of the tree.
       */
      if (
        !snapshot.hasScroller ||
        snapshot.scrollTop + snapshot.clientHeight >=
          snapshot.scrollHeight - 2
      ) {
        break;
      }

      /*
       * Scroll past the furthest position already read to collect additional rows.
       */
      furthest = Math.max(furthest, snapshot.scrollTop);
      const moved = await this.page.evaluate((from) => {
        const first = document.querySelector<HTMLElement>(
          'div.flex.items-center.px-3.py-2.cursor-pointer',
        );
        let scroller: HTMLElement | null = first?.parentElement ?? null;
        while (scroller && scroller !== document.body && scroller.scrollHeight <= scroller.clientHeight + 1) {
          scroller = scroller.parentElement;
        }
        if (!scroller || scroller === document.body) return { now: from, total: 0 };
        scroller.scrollTop = Math.min(from + Math.max(scroller.clientHeight * 0.8, 1), scroller.scrollHeight);
        return { now: scroller.scrollTop, total: scroller.scrollHeight };
      }, furthest);

      // The position must strictly advance, so the loop ends at the bottom of the tree.
      if (moved.now <= furthest) {
        incomplete = `the component tree stopped scrolling at ${Math.round(moved.now)} of ${Math.round(moved.total)} px before reaching its end, so rows below that point could not be read`;
        break;
      }
      furthest = moved.now;

      await this.page.waitForTimeout(100);
    }

    /*
     * Return the tree to the top.
     */
    await this.page.evaluate(() => {
      const first = document.querySelector<HTMLElement>(
        'div.flex.items-center.px-3.py-2.cursor-pointer',
      );

      if (!first) {
        return;
      }

      let scroller: HTMLElement | null =
        first.parentElement;

      while (scroller && scroller !== document.body) {
        if (
          scroller.scrollHeight >
          scroller.clientHeight + 1
        ) {
          break;
        }

        scroller = scroller.parentElement;
      }

      if (scroller && scroller !== document.body) {
        scroller.scrollTop = 0;
      }
    });

    const rows = [...rowsByCode.values()];

    /*
     * Calculate hierarchy depth from the horizontal position.
     */
    const levels = [
      ...new Set(rows.map((row) => row.left)),
    ].sort((a, b) => a - b);

    return {
      rows: rows.map((row) => ({
        code: row.code,
        name: row.name,
        depth: Math.max(0, levels.indexOf(row.left)),
        rawText: row.rawText,
      })),
      complete: !incomplete,
      reason: incomplete,
    };
  }

  /**
   * What this does: Selects a vessel from the dropdown and waits for the component list to refresh.
   * When it's used: Before filtering the component table for a specific vessel.
   * @param name - The vessel name to select.
   * @returns Nothing
   */
  public async selectVessel(
    name = config.vesselName,
  ): Promise<boolean> {
    await expect(
      this.pageLoadedIndicator,
      'The Components page should be ready before selecting a vessel',
    ).toBeVisible();
    await expect
      .poll(
        () => this.vesselDropdown.textContent().then((text) => text?.trim() ?? ''),
        { message: 'The current vessel selection should finish hydrating' },
      )
      .not.toMatch(/^\s*(?:select\s+vessel)?\s*$/i);

    // A browser refresh preserves the current vessel. Re-selecting that same
    // option does not issue a Components request, so reuse the settled state.
    if ((await this.vesselDropdown.textContent() ?? '').includes(name)) {
      return false;
    }

    await this.vesselDropdown.click();
    const vesselOption = this.page.getByRole('option', { name, exact: true });
    await expect(vesselOption, `Vessel option ${name} should finish loading`).toBeVisible({ timeout: 30_000 });
    const vesselTreeResponse = this.page.waitForResponse(
      (response) => response.url().includes('/technical/api/components') && response.request().method() === 'GET',
      { timeout: 10_000 },
    ).catch(() => undefined);
    await vesselOption.click();
    // Some restores reuse already-loaded vessel data and do not issue another
    // GET. The UI selection and settled-tree checks below remain authoritative.
    await vesselTreeResponse;
    await expect(
      this.vesselDropdown,
      `The vessel selector should update to ${name}`,
    ).toContainText(name);
    await expect(
      this.componentCountLabel,
      'The vessel-specific Components tree container should remain available',
    ).toBeVisible();
    await expect(
      this.componentCountLabel.locator('..').locator('[aria-busy="true"]'),
      `The Components tree request for Vessel ${name} should finish`,
    ).toHaveCount(0);
    await this.waitForTreeToSettle(`The Components tree for Vessel ${name} should settle`);
    return true;
  }

  /**
   * Confirms that the vessel-scoped Components screen exposes its primary controls and panels.
   * This deliberately checks the stable accessible controls and section markers rather than styling classes.
   */
  public async expectWorkspaceVisible(vesselName = config.vesselName): Promise<void> {
    await expect(this.vesselDropdown, 'The vessel dropdown should be displayed').toBeVisible();
    await expect(
      this.vesselDropdown,
      `The configured vessel ${vesselName} should be selected`,
    ).toContainText(vesselName);
    await expect(this.componentSearchField, 'The component search field should be displayed').toBeVisible();
    await expect(this.componentCountLabel, 'The Components tree container should be displayed').toBeVisible();
    await expect(this.componentDetailsArea, 'The component details area should be displayed').toBeVisible();
  }

  /** Confirms the vessel retained by navigation or refresh without assuming details-panel state. */
  public async expectVesselSelected(vesselName: string): Promise<void> {
    await expect(this.vesselDropdown, `Vessel ${vesselName} should remain selected`).toContainText(vesselName);
  }

  /**
   * Waits for the selected vessel's tree to reach a usable, non-loading state.
   */
  public async expectTreeLoaded(): Promise<void> {
    await expect
      .poll(
        () => this.componentRows.count(),
        {
          message: 'The Components tree should finish loading visible rows',
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(0);
    await expect(this.componentRows.first(), 'The Components tree should be usable').toBeVisible();
    await expect(
      this.componentCountLabel.locator('..').locator('[aria-busy="true"]'),
      'The Components tree should not remain in a loading state',
    ).toHaveCount(0);
  }

  /** Clears any previous tree filter so a new vessel starts from an unfiltered view. */
  /** Returns the text currently held by the register search box. */
  public async componentSearchText(): Promise<string> {
    return this.componentSearchField.inputValue();
  }

  /**
   * Empties only the search text. The register's Clear button is not used: it also resets the
   * Critical Item filter to All Items, which would silently undo a filter a scenario applied.
   */
  public async clearComponentSearch(): Promise<void> {
    if (await this.componentSearchField.inputValue()) {
      await this.enterSearchText('');
      await this.waitForTreeToSettle('The Components tree should restore after clearing search');
    }
  }

  /**
   * Types into the register search and waits until the text is still there after a short settle.
   * After a reload the page re-applies its saved search once the tree data has loaded, which can
   * overwrite text typed just before; the text is then entered again, a bounded number of times.
   */
  private async enterSearchText(text: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await this.componentSearchField.fill(text);
      const held = await expect.poll(async () => {
        if (await this.componentSearchField.inputValue() !== text) return false;
        await this.page.waitForTimeout(400);
        return await this.componentSearchField.inputValue() === text;
      }, { timeout: 5_000 }).toBe(true).then(() => true, () => false);
      if (held) return;
    }
    await expect(this.componentSearchField, `The Components search should hold "${text}"`).toHaveValue(text);
  }

  /** Finds and selects another vessel-owned component without hardcoded fixture data. */
  public async selectAlternativeComponent(
    excludedCode: string,
    vesselName: string,
  ): Promise<SelectedComponentIdentity> {
    await this.clearComponentSearch();
    const normalizedExcluded = excludedCode.trim().toLowerCase();
    const candidates = (await this.readExpandedTreeRows())
      .filter((row) => row.code.toLowerCase() !== normalizedExcluded)
      .sort((first, second) => second.depth - first.depth);

    for (const candidate of candidates) {
      const identity = await this.searchAndSelectComponentByCode(candidate.code);
      if (identity.vesselName === vesselName) return identity;
    }

    throw new Error(
      `No component other than ${excludedCode} exposed Vessel Name ${vesselName}.`,
    );
  }

  /** Validates the empty-tree UI without assuming application message wording. */
  public async expectEmptyVesselState(vesselName: string): Promise<string> {
    await expect(this.vesselDropdown, `Empty vessel ${vesselName} should be selected`).toContainText(vesselName);
    await expect(this.componentCountLabel, 'The empty Components tree should remain displayed').toBeVisible();
    await expect(this.componentDetailsArea, 'No stale component details should remain displayed').toBeVisible();
    await this.expandAll();
    const rows = await this.readExpandedTreeRows();
    expect(rows.length, 'The empty vessel should retain its usable category tree').toBeGreaterThan(0);
    expect(
      rows.every((row) => row.depth === 0),
      'The empty vessel should contain categories only, without registered equipment descendants',
    ).toBe(true);
    const stateText = (await this.componentCountLabel.locator('..').innerText()).replace(/\s+/g, ' ').trim();
    expect(stateText, 'The empty tree should expose a usable category or count state').not.toBe('');
    return stateText;
  }

  /** Returns whether the details panel currently shows the requested component. */
  public async selectedComponentIsVisible(code: string): Promise<boolean> {
    const escapedCode = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return this.page
      .getByRole('heading', { level: 3, name: new RegExp(`^${escapedCode}(?:\\s|$)`) })
      .filter({ visible: true })
      .last()
      .isVisible()
      .catch(() => false);
  }

  /**
   * What this does: Returns the first visible component row from the list.
   * When it's used: For quick checks on the list content.
   * @returns The first component row locator.
   */
  public firstRow(): Locator {
    return this.componentRows.first();
  }

  public async selectComponentByCode(code: string): Promise<void> {
    const codePattern = new RegExp(
      `^${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`,
    );
    const row = await this.findRenderedComponentRow(codePattern, code);
    await expect(row, `Component ${code} should be present in the expanded tree`).toHaveCount(1);
    await row.scrollIntoViewIfNeeded();
    const wasExpandedParent = await row.locator('svg.lucide-chevron-down').isVisible().catch(() => false);
    let expansionControlClicked = false;
    await row.click();
    if (await this.page.getByText('Select a component to view details', { exact: true }).isVisible().catch(() => false)) {
      await row.locator('button').first().click();
      expansionControlClicked = true;
    }
    await expect(
      this.page.getByText('Select a component to view details', { exact: true }),
    ).toBeHidden();
    await this.waitForSelectedComponent(code);
    // Clicking a parent selects it and can also collapse its descendants. A
    // few leaf rows expose the same right-chevron but render no children when
    // it is clicked, so click at most once and judge expansion by actual rows.
    const collapsedChevron = row.locator('svg.lucide-chevron-right');
    if (!expansionControlClicked && await collapsedChevron.isVisible().catch(() => false)) {
      const rowsBeforeExpansion = new Set(await this.componentRows.allInnerTexts());
      await row.getByRole('button').first().click();
      expansionControlClicked = true;
      // Give the click a short opportunity to start its tree update, then wait
      // for any real loading state. No loading and no new rows means a leaf.
      await this.page.waitForTimeout(250);
      await expect(this.page.getByTestId('B6').locator('[aria-busy="true"]'),
        `Component ${code} child loading should settle`).toHaveCount(0, { timeout: 5_000 });
      const rowsAfterExpansion = await this.componentRows.allInnerTexts();
      const childrenRendered = rowsAfterExpansion.some((text) => !rowsBeforeExpansion.has(text));
      const expandedChevron = await row.locator('svg.lucide-chevron-down').isVisible().catch(() => false);

      // A row already observed as an expanded parent must restore its proven
      // descendants. For an unproven right-chevron, no new rows is a valid leaf.
      if (wasExpandedParent) {
        expect(childrenRendered, `Component ${code} previously displayed child rows and should restore them after selection`).toBe(true);
        expect(expandedChevron, `Component ${code} should remain expanded when its child rows are rendered`).toBe(true);
      }
    }
    this.selectedComponentCode = code.trim().toLowerCase();
  }

  /** Selects one exact rendered occurrence when invalid duplicate rows exist. */
  public async selectExactComponentOccurrence(code: string, occurrence: number): Promise<void> {
    if ((await this.componentSearchField.inputValue()).trim() !== code.trim()) {
      await this.clearComponentSearch();
      await this.searchTree(code);
      await this.expandTreeLevels(8);
    }
    const escapedCode = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const exactRows = this.componentRows.filter({
      hasText: new RegExp(`^${escapedCode}(?:\\s|$)`),
    });
    await expect.poll(
      () => exactRows.count(),
      { message: `Component ${code} occurrence ${occurrence + 1} should exist` },
    ).toBeGreaterThan(occurrence);
    const row = exactRows.nth(occurrence);
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await this.waitForSelectedComponent(code);
    this.selectedComponentCode = code.trim().toLowerCase();
  }

  /**
   * Filters the tree for an exact component code and expands only collapsed
   * nodes that are required to reveal the matching descendant.
   */
  public async searchAndSelectComponentByCode(
    code: string,
  ): Promise<SelectedComponentIdentity> {
    const normalizedCode = code.trim();
    const escapedCode = normalizedCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const exactCodePattern = new RegExp(`^${escapedCode}(?:\\s|$)`);

    await this.clearComponentSearch();
    await this.enterSearchText(normalizedCode);
    await this.waitForTreeToSettle(`The Components search for ${normalizedCode} should settle`);
    if (await this.selectedComponentIsVisible(normalizedCode)) {
      const selectedIdentity = await this.readSelectedComponentIdentity();
      if (selectedIdentity.code === normalizedCode) {
        this.selectedComponentCode = normalizedCode.toLowerCase();
        return selectedIdentity;
      }
    }
    await this.setComponentTreeScrollTop(0);

    const maxExpansions = 100;
    for (let expansion = 0; expansion <= maxExpansions; expansion += 1) {
      // A parent row can include nested descendants in its innerText, which
      // concatenates sibling codes and makes a row-level ^code match miss a
      // visibly rendered child. Anchor on the child's own visible label and
      // then resolve only its nearest clickable row.
      const matchingLabel = this.page.getByTestId('B6').getByText(exactCodePattern).filter({ visible: true }).first();
      const matchingRow = matchingLabel.locator('xpath=ancestor::div[contains(@class,"cursor-pointer")][1]');
      if (await matchingRow.isVisible().catch(() => false)) {
        await matchingRow.scrollIntoViewIfNeeded();
        await matchingRow.click();
        await this.waitForSelectedComponent(normalizedCode);
        this.selectedComponentCode = normalizedCode.toLowerCase();
        return this.readSelectedComponentIdentity();
      }

      const collapsedControl = this.componentRows
        .filter({ has: this.page.locator('svg.lucide-chevron-right') })
        .getByRole('button')
        .first();
      if (!(await collapsedControl.isVisible().catch(() => false))) {
        if (await this.selectedComponentIsVisible(normalizedCode)) {
          const selectedIdentity = await this.readSelectedComponentIdentity();
          if (selectedIdentity.code === normalizedCode) {
            this.selectedComponentCode = normalizedCode.toLowerCase();
            return selectedIdentity;
          }
        }
        await expect
          .poll(
            async () =>
              await matchingRow.isVisible().catch(() => false) ||
              await collapsedControl.isVisible().catch(() => false) ||
              await this.selectedComponentIsVisible(normalizedCode),
            {
              message: `The vessel tree should finish loading while locating Component ${normalizedCode}`,
              timeout: 30_000,
            },
          )
          .toBe(true);
        continue;
      }

      const treeBeforeExpansion = (await this.componentRows.allInnerTexts()).join('\n');
      const expandingRow = collapsedControl.locator('xpath=ancestor::div[contains(@class,"cursor-pointer")][1]');
      const expandingRowText = (await expandingRow.innerText()).replace(/\s+/g, ' ').trim();
      await collapsedControl.click();
      await expect
        .poll(
          async () => {
            const rowIsVisible = await matchingRow.isVisible().catch(() => false);
            const treeChanged = (await this.componentRows.allInnerTexts()).join('\n') !== treeBeforeExpansion;
            const stableRow = this.componentRows.filter({
              hasText: new RegExp(`^${expandingRowText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
            }).first();
            const expanded = await stableRow.locator('svg.lucide-chevron-down').isVisible().catch(() => false);
            return rowIsVisible || treeChanged || expanded;
          },
          {
            message: `The filtered Components tree should update while locating ${normalizedCode}`,
            timeout: 15_000,
          },
        )
        .toBe(true);
      // Expanding an ancestor also selects it in this application, which can
      // replace the search text with that ancestor's code. Restore the exact
      // target before continuing down the already-expanded filtered branch.
      if (await this.componentSearchField.inputValue() !== normalizedCode) {
        await this.enterSearchText(normalizedCode);
        await this.waitForTreeToSettle(`The Components search for ${normalizedCode} should remain active`);
      }
    }

    throw new Error(
      `Component ${normalizedCode} was not found within ${maxExpansions} filtered tree expansions.`,
    );
  }

  /** Reads the three vessel-scope identity fields from the selected component details panel. */
  public async readSelectedComponentIdentity(): Promise<SelectedComponentIdentity> {
    const section = 'A. Component Information';
    const [code, name] = await Promise.all([
      this.readSelectedComponentDetail({ section, label: 'Component Code' }),
      this.readSelectedComponentDetail({ section, label: 'Component Name' }),
    ]);
    const vesselName = await this.readSelectedComponentDetail({
      section: 'B. Fleet Component Information',
      label: 'Vessel Name',
    }).catch(async () => (await this.vesselDropdown.textContent() ?? '').trim());
    expect(vesselName, 'The selected Component should remain scoped to a vessel').not.toBe('');
    return { code, name, vesselName };
  }

  private async findRenderedComponentRow(codePattern: RegExp, code: string): Promise<Locator> {
    await this.setComponentTreeScrollTop(0);
    const targetRow = this.componentRows.filter({ hasText: codePattern }).first();
    // Returning a virtualized tree to scrollTop 0 schedules a rerender. Give
    // that exact target a bounded chance to reappear before deciding that the
    // scroller cannot move and searching later rendered pages.
    const renderedAtTop = await expect.poll(
      () => targetRow.count(),
      { message: `Component tree should render exact code ${code} at the restored scroll position`, timeout: 2_000 },
    ).toBeGreaterThan(0).then(() => true).catch(() => false);
    if (renderedAtTop) return targetRow;
    // Each step must move past the furthest position reached, so the search ends
    // at the bottom of the tree (or where it stops scrolling) without revisiting positions.
    let furthest = 0;
    for (;;) {
      const row = this.componentRows.filter({ hasText: codePattern }).first();
      if (await row.count()) return row;

      const before = (await this.componentRows.allInnerTexts()).join('\n');
      const reached = await this.page.evaluate((from) => {
        const first = document.querySelector<HTMLElement>('div.flex.items-center.px-3.py-2.cursor-pointer');
        let scroller = first?.parentElement ?? null;
        while (scroller && scroller !== document.body && scroller.scrollHeight <= scroller.clientHeight + 1) scroller = scroller.parentElement;
        if (!scroller || scroller === document.body) return from;
        scroller.scrollTop = Math.min(Math.max(from, scroller.scrollTop) + Math.max(scroller.clientHeight * 0.8, 1), scroller.scrollHeight);
        return scroller.scrollTop;
      }, furthest);
      if (reached <= furthest) break;
      furthest = reached;
      await expect.poll(
        () => this.componentRows.allInnerTexts().then((texts) => texts.join('\n')),
        { message: `Component tree should render the next rows while searching for exact code ${code}`, timeout: 2_000 },
      ).not.toBe(before);
    }
    return this.componentRows.filter({ hasText: codePattern }).first();
  }

  private async setComponentTreeScrollTop(scrollTop: number): Promise<void> {
    await this.page.evaluate((target) => {
      const first = document.querySelector<HTMLElement>('div.flex.items-center.px-3.py-2.cursor-pointer');
      let scroller = first?.parentElement ?? null;
      while (scroller && scroller !== document.body && scroller.scrollHeight <= scroller.clientHeight + 1) scroller = scroller.parentElement;
      if (scroller && scroller !== document.body) scroller.scrollTop = target;
    }, scrollTop);
  }

  public async waitForSelectedComponent(code: string): Promise<void> {
    const escapedCode = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const selectedHeading = this.page
      .getByRole('heading', {
        level: 3,
        name: new RegExp(`^${escapedCode}(?:\\s|$)`),
      })
      .filter({ visible: true });
    await expect(
      selectedHeading.last(),
      `The selected Component details should update to code ${code}`,
    ).toBeVisible({ timeout: 30_000 });
  }

  public async readSelectedComponentDetailsText(): Promise<string> {
    return (await this.page.locator('body').innerText())
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** Reads the saved Rotation Item values from the selected Component details. */
  public async readSelectedRotationItem(): Promise<{ rotationalItem: string; stamp: string }> {
    const rotationalItem = this.page.getByTestId('text-rotational-item').filter({ visible: true });
    const stamp = this.page.getByTestId('text-stamp').filter({ visible: true });
    await expect(rotationalItem, 'Saved Rotational Item should be visible').toBeVisible();
    await expect(stamp, 'Saved Stamp should be visible').toBeVisible();
    return {
      rotationalItem: (await rotationalItem.innerText()).trim(),
      stamp: (await stamp.innerText()).replace(/\bReplace\b/gi, '').replace(/\s+/g, ' ').trim(),
    };
  }

  /** Opens the installed Stamp replacement dialog from the selected details. */
  public async openStampReplacement(): Promise<Locator> {
    const stamp = this.page.getByTestId('text-stamp').filter({ visible: true });
    const replace = stamp.getByRole('button', { name: /replace/i }).or(
      this.page.getByRole('button', { name: /replace/i }).filter({ visible: true }),
    ).first();
    await expect(replace, 'An installed Stamp should expose Replace').toBeVisible();
    await replace.click();
    const dialog = this.page.getByRole('dialog').filter({ visible: true }).last();
    await expect(dialog, 'The Stamp replacement popup should open').toBeVisible();
    return dialog;
  }

  /** Reads the replacement stamps listed in the open Replace popup. */
  public async readStampReplacementChoices(dialog: Locator): Promise<Array<{ stamp: string; name: string; status: string }>> {
    const list = dialog.getByTestId('list-available-items');
    // The popup first shows "Loading…" in place of the list; read it only once loading has finished.
    await expect(dialog.getByText(/^Loading/i), 'The Replace popup should finish loading its stamps').toHaveCount(0, { timeout: 30_000 });
    await expect(list, 'The Replace popup should list replacement stamps').toBeVisible();
    return list.locator('[data-testid^="row-item-"]').evaluateAll((rows) => rows.map((row) => {
      const cells = Array.from(row.querySelectorAll('td')).map((cell) => (cell.textContent ?? '').trim());
      return { stamp: cells[1] ?? '', name: cells[2] ?? '', status: cells[3] ?? '' };
    }));
  }

  /** Closes the Replace popup without choosing a stamp. */
  public async closeStampReplacement(dialog: Locator): Promise<void> {
    await this.page.keyboard.press('Escape');
    await expect(dialog, 'The Replace popup should close without a change').toBeHidden();
  }

  public async readSelectedComponentDetail(
    field: ComponentDetailField,
  ): Promise<string> {
    const detailsPanel = this.page.getByTestId('B7');
    await expect(detailsPanel.getByTestId('B7.1'), 'An exact selected Component details panel should be open').toBeVisible();
    const sectionHeading = detailsPanel.getByText(field.section, {
      exact: true,
    }).filter({ visible: true }).last();
    // The primary details panel is reliably identified by its visible field
    // labels. Its decorative section heading is not always rendered, so it
    // must not block validation of an otherwise loaded selected Component.
    if (field.section !== 'A. Component Information') {
      await expect(sectionHeading, `${field.section} should be visible for the selected Component`).toBeVisible({ timeout: 5_000 });
    }

    if (field.section === 'C. Running Hours & Condition Monitoring') {
      const grid = sectionHeading.locator('xpath=following::*[@role="grid"][1]');
      await expect(grid).toBeVisible();
      const headers = await grid.getByRole('columnheader').allInnerTexts();
      const columnIndex = headers.findIndex((header) => header.trim() === field.label);
      if (columnIndex < 0) {
        throw new Error(`${field.label} is not present in ${field.section}.`);
      }
      return (await grid.getByRole('gridcell').nth(columnIndex).innerText()).trim();
    }

    const label = detailsPanel.getByText(field.label, { exact: true }).filter({ visible: true }).last();
    if (
      !(await label.isVisible().catch(() => false)) &&
      await sectionHeading.isVisible().catch(() => false)
    ) {
      await sectionHeading.click();
    }
    await expect(label, `${field.label} should be exposed in ${field.section}`).toBeVisible({ timeout: 5_000 });

    const fieldContainer = label.locator('..');
    const toggle = fieldContainer.locator(
      '[role="switch"], input[type="checkbox"]',
    ).first();
    if (await toggle.count()) {
      const checked = await toggle.getAttribute('aria-checked')
        ?? await toggle.getAttribute('data-state')
        ?? String(await toggle.isChecked().catch(() => false));
      return /^(?:true|checked|on)$/i.test(checked) ? 'Yes' : 'No';
    }

    const lines = (await fieldContainer.innerText())
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.filter((line) => line !== field.label).join(' ').trim();
  }

  public async readJobByCode(jobCode: string): Promise<ComponentJobRow | null> {
    const cachedJobs = this.jobsByComponent.get(this.selectedComponentCode);
    if (cachedJobs) {
      return cachedJobs.find((job) => job.jobCode.toLowerCase() === jobCode.trim().toLowerCase()) ?? null;
    }

    const sectionHeading = this.page.getByText('D. Jobs', { exact: true });
    await expect(sectionHeading, 'The selected Component should expose D. Jobs').toBeVisible();
    await sectionHeading.scrollIntoViewIfNeeded();

    const table = sectionHeading.locator('xpath=following::*[@role="grid" or self::table][1]');
    if (!(await table.isVisible()) && await sectionHeading.isEnabled()) {
      await sectionHeading.click();
    }
    await expect(table, 'The D. Jobs table should be visible').toBeVisible();
    await table.scrollIntoViewIfNeeded();
    let jobsTable = table;
    const expandedDialog = this.page.getByRole('dialog').filter({ hasText: 'Job Code' }).last();
    if (!this.componentsWithExpandedJobs.has(this.selectedComponentCode)) {
      const showAll = sectionHeading.locator(
        'xpath=following::button[contains(normalize-space(.), "Show All (") and contains(translate(normalize-space(.), "JOBS", "jobs"), "jobs)")][1]',
      );
      if (await showAll.count()) {
        await showAll.scrollIntoViewIfNeeded();
      }
      if (await showAll.isVisible()) {
        const rowsBefore = await table.locator('[role="row"], tbody tr').count();
        await showAll.click();
        await expect.poll(
          async () => await expandedDialog.isVisible()
            || await table.locator('[role="row"], tbody tr').count() > rowsBefore,
          'The D. Jobs table should finish updating after Show All is selected',
        ).toBe(true);
        if (await expandedDialog.isVisible()) {
          jobsTable = expandedDialog.locator('[role="grid"], table').filter({ hasText: 'Job Code' }).first();
          await expect(jobsTable, 'The expanded D. Jobs table should be visible').toBeVisible();
        }
        this.componentsWithExpandedJobs.add(this.selectedComponentCode);
      }
    }
    const headers = (await jobsTable.locator('[role="columnheader"], thead th').allInnerTexts()).map((value) => value.trim());
    const rows = jobsTable.locator('[role="row"], tbody tr');
    const jobs: ComponentJobRow[] = [];
    for (let index = 0; index < await rows.count(); index += 1) {
      const row = rows.nth(index);
      const cells = row.locator('[role="gridcell"], td');
      if (!await cells.count()) continue;
      const values = (await cells.allInnerTexts()).map((value) => value.trim());
      const valueFor = (names: string[]) => {
        const column = headers.findIndex((header) => names.some((name) => header.toLowerCase() === name.toLowerCase()));
        return column >= 0 ? values[column] ?? '' : '';
      };
      const rowJobCode = valueFor(['Job Code']);
      if (!rowJobCode) continue;
      jobs.push({
        jobCode: rowJobCode,
        jobTitle: valueFor(['Job Title', 'WO Title']),
        frequency: valueFor(['Frequency']),
        lastDoneDate: valueFor(['Last Done Date']),
        lastDoneHour: valueFor(['Last Done Hour']),
      });
    }
    this.jobsByComponent.set(this.selectedComponentCode, jobs);
    if (await expandedDialog.isVisible()) {
      const closeButton = expandedDialog.getByRole('button', { name: /close/i }).first();
      if (await closeButton.count()) await closeButton.click();
      else await this.page.keyboard.press('Escape');
    }
    return jobs.find((job) => job.jobCode.toLowerCase() === jobCode.trim().toLowerCase()) ?? null;
  }

  /** Reads every linked job currently available for the selected Component. */
  public async readLinkedJobs(): Promise<ComponentJobRow[]> {
    this.jobsByComponent.delete(this.selectedComponentCode);
    await this.readJobByCode('__read_all_jobs__');
    return [...(this.jobsByComponent.get(this.selectedComponentCode) ?? [])];
  }

  /** Reads only the job rows currently displayed without activating Show All. */
  public async readVisibleLinkedJobs(): Promise<ComponentJobRow[]> {
    return this.readJobRows(await this.linkedJobsGrid());
  }

  /** Reads the job rows rendered in a Jobs grid, or in a plain job table when no grid rows exist. */
  private async readJobRows(container: Locator): Promise<ComponentJobRow[]> {
    const rows = container.locator('[role="row"][row-id]');
    if (!(await rows.count())) {
      const headers = (await container.locator('thead th').allInnerTexts()).map((value) => value.trim().toLowerCase());
      const column = (name: string) => headers.indexOf(name.toLowerCase());
      const jobs: ComponentJobRow[] = [];
      for (const values of await container.locator('tbody tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((cell) => (cell.textContent ?? '').trim())))) {
        const at = (name: string) => (column(name) >= 0 ? values[column(name)] ?? '' : '');
        if (!at('Job Code')) continue;
        jobs.push({
          jobCode: at('Job Code'),
          jobTitle: at('Job Title') || at('WO Title'),
          frequency: at('Frequency'),
          lastDoneDate: at('Last Done Date'),
          lastDoneHour: at('Last Done Hour'),
        });
      }
      return jobs;
    }
    await container.locator('.ag-center-cols-viewport').first().evaluate((node) => {
      node.scrollLeft = 0;
    });
    const jobs: ComponentJobRow[] = [];
    for (let index = 0; index < await rows.count(); index += 1) {
      const row = rows.nth(index);
      const value = async (column: string) => {
        const cell = row.locator(`[role="gridcell"][col-id="${column}"]`);
        if (!(await cell.count())) return '';
        return (await cell.getAttribute('title') ?? await cell.innerText()).trim();
      };
      const jobCode = await value('jobNo');
      if (!jobCode) continue;
      jobs.push({
        jobCode,
        jobTitle: await value('jobTitle'),
        frequency: await value('0'),
        lastDoneDate: await value('1'),
        lastDoneHour: await value('2'),
      });
    }
    return jobs;
  }

  /** Section D – Jobs card of the selected Component details. */
  private linkedJobsSection(): Locator {
    return this.page.getByTestId('B7.D').filter({ visible: true }).last();
  }

  /**
   * Waits until Section D – Jobs has finished loading for the selected Component
   * and returns the displayed jobs (without Show All) or its empty-state message.
   */
  public async readLoadedLinkedJobs(): Promise<{ jobs: ComponentJobRow[]; emptyMessage: string }> {
    const grid = await this.linkedJobsGrid();
    await expect(
      grid.getByText('Loading...', { exact: true }).filter({ visible: true }),
      'Section D. Jobs should finish loading for the selected Component',
    ).toHaveCount(0, { timeout: 30_000 });
    const empty = grid.getByText('No jobs found for this component', { exact: true }).filter({ visible: true });
    const rows = grid.locator('[role="row"][row-id]');
    await expect.poll(
      async () => await empty.isVisible().catch(() => false) || await rows.count() > 0,
      { message: 'Section D. Jobs should display job rows or its empty-state message', timeout: 30_000 },
    ).toBe(true);
    if (await empty.isVisible().catch(() => false)) {
      return { jobs: [], emptyMessage: (await empty.innerText()).trim() };
    }
    return { jobs: await this.readJobRows(grid), emptyMessage: '' };
  }

  /**
   * Reads every linked job of the selected Component: when Section D – Jobs
   * shows only part of the list behind Show All, it opens Show All, reads all
   * pages, and collapses the list again.
   */
  public async readAllLinkedJobs(): Promise<{ jobs: ComponentJobRow[]; emptyMessage: string }> {
    const loaded = await this.readLoadedLinkedJobs();
    if (!(await this.readLinkedJobsControls()).showAll) return loaded;
    const shown = await this.showAllLinkedJobs();
    const { jobs } = await this.readJobsAcrossPages(shown.list);
    await this.collapseLinkedJobs(shown.scope, shown.mode);
    return { jobs, emptyMessage: '' };
  }

  /** Reports which list controls Section D – Jobs displays; an empty label means not displayed. */
  public async readLinkedJobsControls(): Promise<{ showAll: string; expand: string; collapse: string; pagination: string }> {
    const section = this.linkedJobsSection();
    const label = async (control: Locator) => (await control.isVisible().catch(() => false)
      ? (await control.innerText()).replace(/\s+/g, ' ').trim() || 'displayed'
      : '');
    const paging = section.locator('.ag-paging-panel:not(.ag-hidden)').filter({ visible: true }).first();
    return {
      showAll: await label(section.getByRole('button', { name: /^Show All\b/i }).filter({ visible: true }).first()),
      expand: await label(section.getByRole('button', { name: /^Expand\b/i }).filter({ visible: true }).first()),
      collapse: await label(section.getByRole('button', { name: /^(Collapse|Show Less|Show Fewer)\b/i }).filter({ visible: true }).first()),
      pagination: await label(paging),
    };
  }

  /**
   * Clicks Section D's Show All control and returns where the full job list is
   * displayed: inline in the section grid, or in a Jobs dialog.
   */
  public async showAllLinkedJobs(): Promise<{ label: string; scope: Locator; list: Locator; mode: 'inline' | 'dialog' }> {
    const section = this.linkedJobsSection();
    const grid = await this.linkedJobsGrid();
    const showAll = section.getByRole('button', { name: /^Show All\b/i }).filter({ visible: true }).first();
    await expect(showAll, 'Section D. Jobs should display Show All').toBeVisible();
    const label = (await showAll.innerText()).replace(/\s+/g, ' ').trim();
    const rowsBefore = await grid.locator('[role="row"][row-id]').count();
    const dialog = this.page.getByRole('dialog').filter({ hasText: 'Job Code' }).filter({ visible: true }).last();
    await showAll.scrollIntoViewIfNeeded();
    await showAll.click();
    await expect.poll(
      async () => await dialog.isVisible().catch(() => false)
        || await grid.locator('[role="row"][row-id]').count() > rowsBefore
        || !(await showAll.isVisible().catch(() => false)),
      { message: 'The Jobs list should update after Show All is selected', timeout: 15_000 },
    ).toBe(true);
    if (await dialog.isVisible().catch(() => false)) return { label, scope: dialog, list: dialog, mode: 'dialog' };
    return { label, scope: section, list: grid, mode: 'inline' };
  }

  /** Clicks the Collapse control displayed after Show All and waits for the Jobs list to return. */
  public async collapseLinkedJobs(scope: Locator, mode: 'inline' | 'dialog'): Promise<string> {
    const collapse = scope.getByRole('button', { name: /^(Collapse|Show Less|Show Fewer)\b/i }).filter({ visible: true }).first();
    await expect(collapse, 'A Collapse control should be displayed for the expanded Jobs list').toBeVisible({ timeout: 10_000 });
    const label = (await collapse.innerText()).replace(/\s+/g, ' ').trim();
    await collapse.click();
    if (mode === 'dialog') await expect(scope, 'The expanded Jobs dialog should close after Collapse').toBeHidden();
    await this.readLoadedLinkedJobs();
    return label;
  }

  /** Clicks the Expand control inside Section D – Jobs and returns where the jobs are then displayed. */
  public async expandLinkedJobs(): Promise<{ label: string; scope: Locator; list: Locator; mode: 'inline' | 'dialog' }> {
    const section = this.linkedJobsSection();
    const expand = section.getByRole('button', { name: /^Expand\b/i }).filter({ visible: true }).first();
    await expect(expand, 'Section D. Jobs should display Expand').toBeVisible();
    const label = (await expand.innerText()).replace(/\s+/g, ' ').trim();
    const dialog = this.page.getByRole('dialog').filter({ hasText: 'Job Code' }).filter({ visible: true }).last();
    await expand.click();
    await expect.poll(
      async () => await dialog.isVisible().catch(() => false) || !(await expand.isVisible().catch(() => false)),
      { message: 'The Jobs list should update after Expand is selected', timeout: 15_000 },
    ).toBe(true);
    if (await dialog.isVisible().catch(() => false)) return { label, scope: dialog, list: dialog, mode: 'dialog' };
    return { label, scope: section, list: await this.linkedJobsGrid(), mode: 'inline' };
  }

  /**
   * Reads every job in a Jobs list, moving through each pagination page when a
   * pager is displayed, then returns to the first page.
   */
  public async readJobsAcrossPages(list: Locator): Promise<{ jobs: ComponentJobRow[]; pageLabels: string[] }> {
    const paging = list.locator('.ag-paging-panel:not(.ag-hidden)').filter({ visible: true }).first();
    const jobs = [...await this.readJobRows(list)];
    if (!(await paging.isVisible().catch(() => false))) return { jobs, pageLabels: [] };
    const pageText = async () => (await paging.locator('.ag-paging-description').innerText()).replace(/\s+/g, ' ').trim();
    const total = Number((await paging.locator('[data-ref="lbTotal"]').innerText()).trim()) || 1;
    const pageLabels = [await pageText()];
    const next = paging.getByRole('button', { name: 'Next Page', exact: true });
    for (let pageNumber = 2; pageNumber <= Math.min(total, 100); pageNumber += 1) {
      await next.click();
      await expect(
        paging.locator('[data-ref="lbCurrent"]'),
        `The Jobs list should move to page ${pageNumber}`,
      ).toHaveText(String(pageNumber));
      pageLabels.push(await pageText());
      jobs.push(...await this.readJobRows(list));
    }
    if (total > 1) {
      await paging.getByRole('button', { name: 'First Page', exact: true }).click();
      await expect(paging.locator('[data-ref="lbCurrent"]'), 'The Jobs list should return to page 1').toHaveText('1');
    }
    return { jobs, pageLabels };
  }

  /** Clicks one tree row and returns the details identity once that same component has loaded. */
  public async selectTreeComponent(row: ComponentTreeRow): Promise<SelectedComponentIdentity> {
    await this.selectComponentByCode(row.code);
    const identity = await this.readSelectedComponentIdentity();
    expect(identity.code, `Component Details should show the clicked Component ${row.code}`).toBe(row.code);
    const normalize = (value: string) => value.replace(/\s*\(Inactive\)\s*/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    // Some names (e.g. classification nodes) already include their code, so the
    // details name can equal the full tree row text rather than the text after the code.
    const detailName = normalize(identity.name);
    const treeTexts = [normalize(row.name), normalize(row.rawText)];
    expect(
      treeTexts.some((text) => text === detailName || text.startsWith(`${detailName} `)),
      `Component Details name "${identity.name}" should belong to the clicked tree row "${row.code} ${row.name}"`,
    ).toBe(true);
    return identity;
  }

  /** Returns whether a rendered tree row is a leaf, collapsed parent, or expanded parent. */
  public async treeComponentExpansionState(code: string): Promise<'leaf' | 'collapsed' | 'expanded'> {
    const pattern = new RegExp(`^${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);
    const row = await this.findRenderedComponentRow(pattern, code);
    if (await row.locator('svg.lucide-chevron-down').isVisible().catch(() => false)) return 'expanded';
    if (await row.locator('svg.lucide-chevron-right').isVisible().catch(() => false)) return 'collapsed';
    return 'leaf';
  }

  /**
   * Clicks one collapsed row's chevron (never Expand All) and waits for the tree
   * to settle. A node can show a chevron yet render no children, so the caller
   * judges the result from the rows displayed afterwards.
   */
  public async expandTreeComponent(code: string): Promise<void> {
    const pattern = new RegExp(`^${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);
    const row = await this.findRenderedComponentRow(pattern, code);
    await expect(row, `Component ${code} should be rendered before expanding it`).toHaveCount(1);
    const rowsBefore = await this.componentRows.count();
    await row.getByRole('button').first().click();
    // Children load asynchronously; wait (bounded) for them before judging the result.
    await expect.poll(
      async () => await row.locator('svg.lucide-chevron-down').isVisible().catch(() => false)
        || await this.componentRows.count() !== rowsBefore,
      { timeout: 5_000 },
    ).toBe(true).catch(() => undefined);
    await this.waitForTreeToSettle(`Component ${code} children should settle after expansion`);
  }

  /** Opens the real Add Job form from the selected component's D. Jobs section. */
  public async openAddJob(): Promise<JobFormPage> {
    const heading = this.page.getByText('D. Jobs', { exact: true }).filter({ visible: true });
    await expect(heading, 'The selected Component should expose D. Jobs').toBeVisible();
    await heading.scrollIntoViewIfNeeded();
    const button = this.page.getByRole('button', { name: /^\+\s*Add Jobs?$/i }).filter({ visible: true });
    if (!(await button.isVisible().catch(() => false))) {
      const edit = this.page.getByRole('button', { name: 'Edit Component', exact: true }).filter({ visible: true });
      await expect(edit, 'The selected saved Component should expose Edit Component before adding a job').toBeVisible();
      await edit.click();
      await expect(this.page.getByRole('heading', { name: /edit component/i })).toBeVisible();
      await this.page.waitForLoadState('networkidle');
    }
    await expect(button, 'D. Jobs should expose the available Add Job action').toBeVisible();
    await button.click();
    const form = new JobFormPage(this.page);
    await expect(this.page.getByRole('heading', { name: 'Job Form', exact: true })).toBeVisible();
    return form;
  }

  /** Returns the selected Component's Jobs grid after expanding Section D if necessary. */
  public async linkedJobsGrid(): Promise<Locator> {
    const heading = this.page.getByText('D. Jobs', { exact: true }).filter({ visible: true });
    await expect(heading, 'The selected Component should expose D. Jobs').toBeVisible();
    await heading.scrollIntoViewIfNeeded();
    const grid = this.page.getByTestId('component-jobs-grid').filter({ visible: true });
    if (!(await grid.isVisible().catch(() => false))) await heading.click();
    await expect(grid, 'The selected Component Jobs grid should be visible').toBeVisible();
    await expect(grid.locator('[aria-busy="true"]'), 'The selected Component Jobs grid should finish loading').toHaveCount(0);
    return grid;
  }

  /**
   * Returns the Generate WO button in the Action column of one exact job,
   * scrolling the Jobs grid horizontally so the Action column is rendered.
   */
  public async generateWorkOrderButton(jobCode: string): Promise<Locator> {
    const grid = await this.linkedJobsGrid();
    await grid.locator('.ag-center-cols-viewport').first().evaluate((node) => {
      node.scrollLeft = node.scrollWidth;
    });
    return grid.getByTestId(`btn-generate-wo-${jobCode}`).filter({ visible: true });
  }

  /**
   * Clicks Generate WO for one exact job, chooses the requested reason (or the
   * first reason the popup offers), confirms when asked, and returns the
   * application's response and visible message. It does not judge success.
   */
  public async generateWorkOrder(
    jobCode: string,
    preferredReason = /^Planning\b/i,
  ): Promise<GeneratedWorkOrderResult> {
    const generate = await this.generateWorkOrderButton(jobCode);
    await expect(generate, `Job ${jobCode} should expose Generate WO in the Action column`).toBeVisible();
    await generate.click();
    const dialog = this.page.getByRole('dialog').filter({ hasText: 'Generate Work Order' }).filter({ visible: true }).last();
    await expect(dialog, 'Generate Work Order options should be displayed').toBeVisible();
    const choices = dialog.getByRole('button').filter({ hasNotText: /^(cancel|close|×)?$/i });
    const labels = (await choices.allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim());
    const reasonIndex = Math.max(labels.findIndex((label) => preferredReason.test(label)), 0);
    const reason = labels[reasonIndex] ?? '';
    expect(reason, 'The Generate Work Order popup should offer at least one reason').not.toBe('');
    const responsePromise = this.page.waitForResponse((response) =>
      /\/technical\/api\/jobs\/[^/]+\/generate-wo(?:\?|$)/i.test(response.url())
      && response.request().method() === 'POST');
    await choices.nth(reasonIndex).click();
    const confirm = this.page.getByRole('dialog').filter({ visible: true }).last()
      .getByRole('button', { name: /^(confirm|generate|yes|ok|submit)\b/i });
    const confirmed = await Promise.race([
      responsePromise.then(() => false),
      confirm.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false),
    ]);
    if (confirmed) await confirm.click();
    const response = await responsePromise;
    const responseBody = await response.text().catch(() => '');
    const parsed = parseWorkOrderResponse(responseBody);
    const feedback = await readAppNotification(this.page)
      || parsed.message
      || `The application returned HTTP ${response.status()}.`;
    return {
      jobCode,
      reason,
      httpStatus: response.status(),
      feedback,
      responseBody,
      workOrderNumber: parsed.workOrderNumber,
      status: parsed.status,
    };
  }

  /** Screenshot of the selected Component's Section D – Jobs, used as evidence. */
  public async linkedJobsSectionScreenshot(): Promise<Buffer> {
    const section = this.linkedJobsSection();
    await section.scrollIntoViewIfNeeded();
    return section.screenshot({ animations: 'disabled' });
  }

  /** Clicks one exact job in Section D – Jobs and waits for its Jobs Form page. */
  public async openLinkedJob(jobCode: string): Promise<JobFormPage> {
    const grid = await this.linkedJobsGrid();
    await grid.locator('.ag-center-cols-viewport').first().evaluate((node) => {
      node.scrollLeft = 0;
    });
    const cell = grid.getByRole('gridcell', { name: jobCode, exact: true });
    await expect(cell, `Job ${jobCode} should be listed in Section D. Jobs`).toBeVisible();
    await cell.click();
    await this.page.waitForURL(/\/technical\/pms\/job\/[^/?]+/, { timeout: 30_000 });
    await expect(this.page.getByRole('heading', { name: 'Jobs Form', exact: true }), `Job ${jobCode} details should open`).toBeVisible();
    return new JobFormPage(this.page);
  }

  public async readSpareByPartCode(partCode: string): Promise<ComponentSpareRow | null> {
    const cached = this.sparesByComponent.get(this.selectedComponentCode);
    if (cached) return cached.find((spare) => spare.partCode.toLowerCase() === partCode.trim().toLowerCase()) ?? null;
    const heading = this.page.getByText('F. Spares', { exact: true });
    await expect(heading, 'The selected Component should expose F. Spares').toBeVisible();
    await heading.scrollIntoViewIfNeeded();
    let table = heading.locator('xpath=following::*[@role="grid" or self::table][1]');
    if (!(await table.isVisible())) await heading.click();
    await expect(table, 'The F. Spares table should be visible').toBeVisible();
    await table.scrollIntoViewIfNeeded();
    const dialog = this.page.getByRole('dialog').filter({ hasText: 'Part Code' }).last();
    if (!this.componentsWithExpandedSpares.has(this.selectedComponentCode)) {
      const showAll = this.page.getByRole('button', {
        name: /^Show All \(\d+\s+spares?\)$/i,
      }).last();
      if (await showAll.count()) {
        await showAll.scrollIntoViewIfNeeded();
      }
      if (await showAll.isVisible()) {
        const rowsBefore = await table.locator('[role="row"], tbody tr').count();
        await showAll.click();
        await expect.poll(
          async () => await dialog.isVisible()
            || await table.locator('[role="row"], tbody tr').count() > rowsBefore,
          'The F. Spares table should finish updating after Show All is selected',
        ).toBe(true);
        this.componentsWithExpandedSpares.add(this.selectedComponentCode);
      }
    }
    if (await dialog.isVisible()) {
      table = dialog.locator('[role="grid"], table').filter({ hasText: 'Part Code' }).first();
      await expect(table, 'The expanded F. Spares table should be visible').toBeVisible();
    }
    const headers = (await table.locator('[role="columnheader"], thead th').allInnerTexts()).map((value) => value.trim().toLowerCase());
    const sparesByPartCode = new Map<string, ComponentSpareRow>();
    const readVisibleRows = async () => {
      const rows = table.locator('[role="row"], tbody tr');
      for (let index = 0; index < await rows.count(); index += 1) {
        const values = (await rows.nth(index).locator('[role="gridcell"], td').allInnerTexts()).map((value) => value.trim());
        if (!values.length) continue;
        const valueFor = (patterns: RegExp[]) => {
          const column = headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
          return column >= 0 ? values[column] ?? '' : '';
        };
        const rowPartCode = valueFor([/^part code$/i]);
        if (!rowPartCode) continue;
        sparesByPartCode.set(rowPartCode.toLowerCase(), {
          partCode: rowPartCode,
          partName: valueFor([/^part name$/i]),
          componentName: valueFor([/^component(?: name)?$/i]),
          partNumber: valueFor([/^part number$/i]),
          rob: valueFor([/^rob$/i, /total rob/i]),
          min: valueFor([/^min(?:imum)?$/i]),
          stock: valueFor([/^stock$/i]),
          location: valueFor([/^location$/i]),
        });
      }
    };

    const paginationStatus = this.page.getByText(/^Page \d+ of \d+$/).last();
    const visitedPages = new Set<string>();
    while (true) {
      await readVisibleRows();
      if (!(await paginationStatus.isVisible())) break;
      const currentPage = (await paginationStatus.innerText()).trim();
      if (visitedPages.has(currentPage)) {
        throw new Error(`F. Spares pagination did not advance from ${currentPage}.`);
      }
      visitedPages.add(currentPage);
      const nextPage = paginationStatus.locator('..').getByRole('button').last();
      if (!(await nextPage.isEnabled())) break;
      await nextPage.click();
      await expect(paginationStatus, 'The F. Spares table should load the next page').not.toHaveText(currentPage);
    }
    const spares = [...sparesByPartCode.values()];
    this.sparesByComponent.set(this.selectedComponentCode, spares);
    if (await dialog.isVisible()) {
      const close = dialog.getByRole('button', { name: /close/i }).first();
      if (await close.count()) await close.click(); else await this.page.keyboard.press('Escape');
    }
    return spares.find((spare) => spare.partCode.toLowerCase() === partCode.trim().toLowerCase()) ?? null;
  }

  /** Section F - Spares card of the selected Component details. */
  private linkedSparesSection(): Locator {
    const byId = this.page.getByTestId('B7.F').filter({ visible: true }).last();
    const byHeading = this.page.getByText('F. Spares', { exact: true }).filter({ visible: true }).last()
      .locator('xpath=ancestor::*[self::section or self::div][.//*[@role="grid"] or .//table][1]');
    return byId.or(byHeading).last();
  }

  private async linkedSparesGrid(scope?: Locator): Promise<Locator> {
    const grid = (scope ?? this.linkedSparesSection()).locator('[role="grid"], table').filter({ visible: true }).first();
    await expect(grid, 'Section F. Spares should display its spare-parts list').toBeVisible({ timeout: 30_000 });
    return grid;
  }

  private async spareGridRoot(container: Locator): Promise<Locator> {
    const directRows = container.locator('[role="row"][row-id], tbody tr');
    return await directRows.count() ? container : await this.linkedSparesGrid(container);
  }

  private snapshotSpareGrid(grid: Locator, allColumns = true): Promise<SpareGridSnapshot> {
    return snapshotSpareGrid(grid, allColumns);
  }

  private spareRowFromSnapshot(snapshot: SpareGridSnapshot, row: SpareGridSnapshot['rows'][number]): ComponentSpareRow {
    return spareRowFromSnapshot(snapshot, row);
  }

  /**
   * Scrolls the F. Spares grid horizontally until the column whose header matches
   * (for example Stock) is displayed, so evidence screenshots show that column.
   * Returns false when no such column is rendered at any scroll position.
   */
  public async revealSpareGridColumn(header: RegExp, container: Locator = this.linkedSparesSection()): Promise<boolean> {
    const root = await this.spareGridRoot(container);
    return root.evaluate(async (node, pattern) => {
      const matcher = new RegExp(pattern.source, pattern.flags);
      const scroller = [...node.querySelectorAll<HTMLElement>('.ag-body-horizontal-scroll-viewport, .ag-center-cols-viewport')]
        .find((item) => item.scrollWidth > item.clientWidth + 1);
      const center = node.querySelector<HTMLElement>('.ag-center-cols-viewport');
      const find = () => [...node.querySelectorAll<HTMLElement>('[role="columnheader"], thead th')]
        .find((item) => matcher.test((item.innerText ?? '').replace(/\s+/g, ' ').trim()));
      const frames = async (count: number) => { for (let index = 0; index < count; index += 1) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); };
      const scrollTo = async (left: number) => {
        if (!scroller) return;
        scroller.scrollLeft = left;
        if (center && center !== scroller) center.scrollLeft = left;
        await frames(3);
      };
      let target = find();
      if (scroller) {
        const max = scroller.scrollWidth - scroller.clientWidth;
        for (let left = 0; !target; left = Math.min(left + Math.max(scroller.clientWidth * 0.75, 50), max)) {
          await scrollTo(left);
          target = find();
          if (left >= max) break;
        }
        if (target) {
          const offset = target.getBoundingClientRect().left - scroller.getBoundingClientRect().left;
          if (offset < 0 || offset + target.offsetWidth > scroller.clientWidth) await scrollTo(Math.max(0, scroller.scrollLeft + offset - 24));
          target = find();
        }
      }
      return Boolean(target);
    }, { source: header.source, flags: header.flags });
  }

  /** Reads Part Code, Part Name, ROB, Min, Stock and the other columns of every displayed spare row; `allColumns: false` reads only the columns currently rendered. */
  private async readSpareRows(container: Locator, allColumns = true): Promise<ComponentSpareRow[]> {
    const snapshot = await this.snapshotSpareGrid(await this.spareGridRoot(container), allColumns);
    return snapshot.rows
      .map((row) => this.spareRowFromSnapshot(snapshot, row))
      .filter((spare) => spare.partCode || spare.partName);
  }

  /** Waits for Section F and reads the displayed spare rows or empty state. */
  public async readLoadedLinkedSpares(): Promise<SpareListState> {
    const heading = this.page.getByText('F. Spares', { exact: true }).filter({ visible: true }).last();
    await expect(heading, 'The selected Component should expose F. Spares').toBeVisible({ timeout: 30_000 });
    await heading.scrollIntoViewIfNeeded();
    const section = this.linkedSparesSection();
    await expect(section.getByText('Loading...', { exact: true }).filter({ visible: true }),
      'Section F. Spares should finish loading').toHaveCount(0, { timeout: 30_000 });
    const exactEmpty = section.getByText('No spare parts linked to this component', { exact: true }).filter({ visible: true }).first();
    const fallbackEmpty = section.getByText(/No spare parts linked to this component[.!]?/i).filter({ visible: true }).first();
    const empty = await exactEmpty.count() ? exactEmpty : fallbackEmpty;
    const grid = section.locator('[role="grid"], table').filter({ visible: true }).first();
    await expect.poll(async () => await empty.isVisible().catch(() => false) || await grid.isVisible().catch(() => false), {
      message: 'Section F. Spares should display spare rows or its empty-state message', timeout: 30_000,
    }).toBe(true);
    if (await empty.isVisible().catch(() => false)) {
      return { spares: [], emptyMessage: (await empty.innerText()).replace(/\s+/g, ' ').trim() };
    }
    return { spares: await this.readSpareRows(section), emptyMessage: '' };
  }

  public async readLinkedSparesControls(): Promise<{ showAll: string; collapse: string; pagination: string }> {
    const section = this.linkedSparesSection();
    const label = async (locator: Locator) => await locator.isVisible().catch(() => false)
      ? (await locator.innerText()).replace(/\s+/g, ' ').trim() || 'displayed' : '';
    return {
      showAll: await label(section.getByRole('button', { name: /^Show All\b/i }).filter({ visible: true }).first()),
      collapse: await label(section.getByRole('button', { name: /^(Collapse|Show Less|Show Fewer)\b/i }).filter({ visible: true }).first()),
      pagination: await label(section.locator('.ag-paging-panel:not(.ag-hidden)').filter({ visible: true }).first()),
    };
  }

  public async showAllLinkedSpares(): Promise<SpareListView> {
    const section = this.linkedSparesSection();
    const grid = await this.linkedSparesGrid(section);
    const showAll = section.getByRole('button', { name: /^Show All\b/i }).filter({ visible: true }).first();
    await expect(showAll, 'Section F. Spares should display Show All').toBeVisible();
    const label = (await showAll.innerText()).replace(/\s+/g, ' ').trim();
    const before = await this.readSpareRows(section, false);
    const dialog = this.page.getByRole('dialog').filter({ hasText: /Part Code|Part Name/i }).filter({ visible: true }).last();
    await showAll.click();
    await expect.poll(async () => await dialog.isVisible().catch(() => false)
      || (await this.readSpareRows(section, false)).length > before.length
      || !(await showAll.isVisible().catch(() => false)), { timeout: 15_000 }).toBe(true);
    if (await dialog.isVisible().catch(() => false)) return { label, scope: dialog, list: dialog, mode: 'dialog' };
    return { label, scope: section, list: grid, mode: 'inline' };
  }

  public async collapseLinkedSpares(view: SpareListView): Promise<string> {
    const collapse = view.scope.getByRole('button', { name: /^(Collapse|Show Less|Show Fewer)\b/i }).filter({ visible: true }).first();
    await expect(collapse, 'The expanded Spares list should display Collapse').toBeVisible({ timeout: 10_000 });
    const label = (await collapse.innerText()).replace(/\s+/g, ' ').trim();
    await collapse.click();
    if (view.mode === 'dialog') await expect(view.scope).toBeHidden();
    await this.readLoadedLinkedSpares();
    return label;
  }

  /** Reads the application's visible "Page X of Y" control and the records on that page. */
  public async readLinkedSparesPage(view: SpareListView): Promise<SparePageState | undefined> {
    const indicator = view.scope.getByText(/^Page \d+ of \d+$/i).filter({ visible: true }).first();
    if (!(await indicator.isVisible().catch(() => false))) return undefined;
    const label = (await indicator.innerText()).replace(/\s+/g, ' ').trim();
    const match = label.match(/^Page (\d+) of (\d+)$/i);
    if (!match) return undefined;
    return {
      label,
      currentPage: Number(match[1]),
      totalPages: Number(match[2]),
      spares: await this.readSpareRows(view.list),
    };
  }

  /** Uses the arrow beside "Page X of Y" and waits for both page number and records to update. */
  public async navigateLinkedSparesPage(view: SpareListView, direction: 'next' | 'previous'): Promise<SparePageState> {
    const before = await this.readLinkedSparesPage(view);
    expect(before, 'The expanded F. Spares list should display a Page X of Y indicator').toBeTruthy();
    const indicator = view.scope.getByText(/^Page \d+ of \d+$/i).filter({ visible: true }).first();
    const controls = indicator.locator('..').getByRole('button');
    const button = direction === 'next' ? controls.last() : controls.first();
    await expect(button, `The ${direction} Spares page arrow should be enabled`).toBeEnabled();
    await button.click();
    const expectedPage = before!.currentPage + (direction === 'next' ? 1 : -1);
    await expect(indicator, `F. Spares should move to Page ${expectedPage} of ${before!.totalPages}`)
      .toHaveText(new RegExp(`^Page ${expectedPage} of ${before!.totalPages}$`, 'i'));
    // The page number can change before the rows do. Wait for this page's own rows;
    // if the previous page's rows remain, the page made no progress and reading stops here.
    const signature = (spares: ComponentSpareRow[]) => spares.map((spare) => `${spare.partCode}\u0000${spare.partName}`).join('\n');
    let after: SparePageState | undefined;
    await expect.poll(async () => {
      after = await this.readLinkedSparesPage(view);
      return Boolean(after?.spares.length) && after!.currentPage === expectedPage && signature(after!.spares) !== signature(before!.spares);
    }, {
      message: `F. Spares showed Page ${expectedPage} of ${before!.totalPages}, but its rows did not change from ${before!.label}, so the page made no progress and the remaining pages could not be read reliably`,
      timeout: 10_000,
    }).toBe(true);
    return after!;
  }

  public async readSparesAcrossPages(list: Locator, pagingScope: Locator = list): Promise<{ spares: ComponentSpareRow[]; pageLabels: string[] }> {
    const customIndicator = pagingScope.getByText(/^Page \d+ of \d+$/i).filter({ visible: true }).first();
    if (await customIndicator.isVisible().catch(() => false)) {
      const view: SpareListView = { label: '', scope: pagingScope, list, mode: 'inline' };
      let state = await this.readLinkedSparesPage(view);
      expect(state, 'The expanded F. Spares page should be readable').toBeTruthy();
      while (state!.currentPage > 1) state = await this.navigateLinkedSparesPage(view, 'previous');
      const byKey = new Map<string, ComponentSpareRow>();
      const pageLabels: string[] = [];
      while (state) {
        pageLabels.push(state.label);
        for (const spare of state.spares) byKey.set(`${spare.partCode}\u0000${spare.partName}`, spare);
        if (state.currentPage >= state.totalPages) break;
        state = await this.navigateLinkedSparesPage(view, 'next');
      }
      while (state!.currentPage > 1) state = await this.navigateLinkedSparesPage(view, 'previous');
      return { spares: [...byKey.values()], pageLabels };
    }
    const paging = list.locator('.ag-paging-panel:not(.ag-hidden)').filter({ visible: true }).first();
    const spares = [...await this.readSpareRows(list)];
    if (!(await paging.isVisible().catch(() => false))) {
      const viewport = list.locator('.ag-body-viewport, .ag-center-cols-viewport').filter({ visible: true }).first();
      if (!(await viewport.isVisible().catch(() => false))) return { spares, pageLabels: [] };
      const byKey = new Map(spares.map((spare) => [`${spare.partCode}\u0000${spare.partName}`, spare]));
      // Scrolling must advance past the furthest position read; a list that stops
      // scrolling before its end is reported instead of being re-read indefinitely.
      let furthest = -1;
      for (;;) {
        const position = await viewport.evaluate((node) => ({
          top: node.scrollTop,
          height: node.clientHeight,
          total: node.scrollHeight,
        }));
        for (const spare of await this.readSpareRows(list)) byKey.set(`${spare.partCode}\u0000${spare.partName}`, spare);
        if (position.top + position.height >= position.total - 2) break;
        furthest = Math.max(furthest, position.top);
        const reached = await viewport.evaluate((node, from) => {
          node.scrollTop = Math.min(from + Math.max(node.clientHeight * 0.8, 1), node.scrollHeight);
          return node.scrollTop;
        }, furthest);
        if (reached <= furthest) {
          throw new Error(`Observed Application Result:\nThe spare list stopped scrolling at ${Math.round(reached)} of ${Math.round(position.total)} px before its end, so the remaining spare rows could not be read.`);
        }
        furthest = reached;
        await this.page.waitForTimeout(100);
      }
      await viewport.evaluate((node) => { node.scrollTop = 0; });
      return { spares: [...byKey.values()], pageLabels: [] };
    }
    const current = paging.locator('[data-ref="lbCurrent"]');
    const total = Number((await paging.locator('[data-ref="lbTotal"]').innerText()).trim()) || 1;
    const describe = async () => (await paging.innerText()).replace(/\s+/g, ' ').trim();
    const pageLabels = [await describe()];
    // Every page is read; each Next Page click must show the next page number, so the loop always advances.
    for (let number = 2; number <= total; number += 1) {
      await paging.getByRole('button', { name: 'Next Page', exact: true }).click();
      await expect(current).toHaveText(String(number));
      pageLabels.push(await describe());
      spares.push(...await this.readSpareRows(list));
    }
    if (total > 1) {
      await paging.getByRole('button', { name: 'First Page', exact: true }).click();
      await expect(current).toHaveText('1');
    }
    return { spares, pageLabels };
  }

  private async findSpareRow(container: Locator, spare: ComponentSpareRow): Promise<Locator> {
    const key = spare.partCode || spare.partName;
    return container.locator('[role="row"][row-id], tbody tr').filter({ hasText: key }).first();
  }

  public async spareHasLocationView(spare: ComponentSpareRow, container?: Locator): Promise<boolean> {
    const row = await this.findSpareRow(container ?? this.linkedSparesSection(), spare);
    return row.getByRole('button', { name: /^View(?:\s*\(\d+\))?$/i }).or(row.getByRole('link', { name: /^View(?:\s*\(\d+\))?$/i }))
      .filter({ visible: true }).first().isVisible().catch(() => false);
  }

  /** Reads actual Location View links on every F. Spares page, including the horizontally virtualised Location column. */
  public async discoverSparesWithLocationView(view?: SpareListView): Promise<SpareWithLocationView[]> {
    const listView = this.defaultSpareView(view);
    const inventory = await this.discoverLinkedSpares(view);
    const eligible: SpareWithLocationView[] = [];
    const pages = new Map<number, DiscoveredSpare[]>();
    for (const spare of inventory.spares) {
      const page = spare.page || 1;
      pages.set(page, [...(pages.get(page) ?? []), spare]);
    }
    for (const [page, spares] of [...pages].sort(([left], [right]) => left - right)) {
      if (spares[0]?.page) await this.goToLinkedSparesPage(listView, page);
      const root = await this.spareGridRoot(listView.list);
      const identities = await Promise.all(spares.map((spare) => this.findExactSpareRowIdentity(listView.list, spare)));
      await this.revealSpareGridColumn(/^Location$/i, listView.list);
      for (let index = 0; index < spares.length; index += 1) {
        const row = this.spareRowFromIdentity(root, identities[index]);
        const link = row.getByRole('button', { name: /^View(?:\s*\(\d+\))?$/i })
          .or(row.getByRole('link', { name: /^View(?:\s*\(\d+\))?$/i })).filter({ visible: true }).first();
        if (await link.isVisible().catch(() => false)) eligible.push({ ...spares[index], viewLabel: (await link.innerText()).replace(/\s+/g, ' ').trim() });
      }
    }
    if (inventory.spares.some((spare) => spare.page > 0)) await this.goToLinkedSparesPage(listView, 1);
    return eligible;
  }
  public async openSpareDetails(spare: ComponentSpareRow, container?: Locator): Promise<SpareDetailsState> {
    const scope = container ?? this.linkedSparesSection();
    const row = await this.findSpareRow(scope, spare);
    await expect(row, `Spare ${spare.partCode || spare.partName} should be displayed`).toBeVisible();
    const dialog = this.page.getByRole('dialog').filter({ hasText: /Linked Components/i }).filter({ visible: true }).last();
    const clickable = row.getByText(spare.partCode || spare.partName, { exact: true }).first();
    if (await clickable.count()) await clickable.click(); else await row.click();
    await expect(dialog, 'The spare details popup should display Linked Components').toBeVisible({ timeout: 15_000 });
    const linkedHeading = dialog.getByText(/Linked Components/i).first();
    const linkedList = linkedHeading.locator('xpath=following::*[@role="grid" or self::table or self::ul][1]');
    const source = await linkedList.count() ? linkedList : dialog;
    let texts = await source.locator('[role="row"][row-id], tbody tr, li').allInnerTexts();
    if (!texts.length) texts = [(await dialog.innerText()).replace(/\s+/g, ' ').trim()];
    return { spare, dialog, linkedComponentTexts: texts.map((text) => text.replace(/\s+/g, ' ').trim()).filter(Boolean) };
  }

  public async closeSparePopup(dialog: Locator): Promise<void> {
    const close = dialog.getByRole('button', { name: /^(Close|Cancel|Done|OK|Ã—)$/i }).filter({ visible: true }).first();
    if (await close.count()) await close.click(); else await this.page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  }

  private defaultSpareView(view?: SpareListView): SpareListView {
    if (view) return view;
    const section = this.linkedSparesSection();
    return { label: '', scope: section, list: section, mode: 'inline' };
  }

  /**
   * Reads every linked spare once, page by page, recording the page where each
   * unique spare (Part Code + Part Name) appears. No spare popup is opened. The
   * list is left on its last page, so callers visiting spares in descending page
   * order need the fewest page changes.
   */
  public async discoverLinkedSpares(view?: SpareListView): Promise<LinkedSpareInventory> {
    const listView = this.defaultSpareView(view);
    const byKey = new Map<string, DiscoveredSpare>();
    let rowsRead = 0;
    const add = (spares: ComponentSpareRow[], page: number) => {
      rowsRead += spares.length;
      for (const spare of spares) {
        const key = `${spare.partCode}\u0000${spare.partName}`;
        if (!byKey.has(key)) byKey.set(key, { ...spare, page });
      }
    };
    let state = await this.readLinkedSparesPage(listView);
    if (!state) {
      const all = await this.readSparesAcrossPages(listView.list, listView.scope);
      add(all.spares, 0);
      return { spares: [...byKey.values()], rowsRead, totalPages: 1, pageLabels: all.pageLabels };
    }
    if (state.currentPage !== 1) state = await this.goToLinkedSparesPage(listView, 1);
    const pageLabels: string[] = [];
    for (;;) {
      pageLabels.push(state.label);
      add(state.spares, state.currentPage);
      if (state.currentPage >= state.totalPages) break;
      state = await this.navigateLinkedSparesPage(listView, 'next');
    }
    return { spares: [...byKey.values()], rowsRead, totalPages: state.totalPages, pageLabels };
  }

  /** Moves the expanded F. Spares list to a page using its arrows, verifying every page change. */
  public async goToLinkedSparesPage(view: SpareListView, page: number): Promise<SparePageState> {
    let state = await this.readLinkedSparesPage(view);
    if (!state) throw new Error(`The F. Spares list did not display a Page X of Y indicator, so Page ${page} could not be opened.`);
    if (page < 1 || page > state.totalPages) throw new Error(`Page ${page} is outside the F. Spares range of ${state.totalPages} page(s).`);
    while (state.currentPage !== page) {
      state = await this.navigateLinkedSparesPage(view, state.currentPage < page ? 'next' : 'previous');
    }
    return state;
  }

  /** Captures stable row identity while Part Code and Part Name are rendered during a full horizontal scan. */
  private async findExactSpareRowIdentity(scope: Locator, spare: ComponentSpareRow & { page?: number }, timeout = 10_000): Promise<{ rowId: string; domIndex: number }> {
    let match: { rowId: string; domIndex: number } | undefined;
    await expect.poll(async () => {
      const snapshot = await this.snapshotSpareGrid(await this.spareGridRoot(scope), true).catch(() => undefined);
      match = snapshot?.rows.find((row) => {
        const values = this.spareRowFromSnapshot(snapshot, row);
        return values.partCode === spare.partCode && values.partName === spare.partName;
      });
      return Boolean(match);
    }, { timeout }).toBe(true).catch(() => undefined);
    if (!match) {
      throw new Error(`Observed Application Result:\nSpare ${spare.partCode || '[no code]'} (${spare.partName || '[no name]'}) was not displayed in the F. Spares list${spare.page ? ` on Page ${spare.page}` : ''}, so its details could not be opened.\n\nNo row with that exact Part Code and Part Name was rendered during a complete horizontal-column scan within ${timeout} ms.`);
    }
    return match;
  }

  /** Resolves current DOM fragments for a captured row without depending on virtualised identity-column text. */
  private spareRowFromIdentity(root: Locator, identity: { rowId: string; domIndex: number }): Locator {
    return identity.rowId
      ? root.locator(`[role="row"][row-id="${identity.rowId}"]`)
      : root.locator('tbody tr').nth(identity.domIndex);
  }

  private async findExactSpareRow(scope: Locator, spare: ComponentSpareRow & { page?: number }, timeout = 10_000): Promise<Locator> {
    const root = await this.spareGridRoot(scope);
    return this.spareRowFromIdentity(root, await this.findExactSpareRowIdentity(scope, spare, timeout));
  }
  /** Opens one spare from its recorded page, matching Part Code and Part Name exactly, and reads its popup. */
  public async openSparePartDetails(spare: DiscoveredSpare, view?: SpareListView): Promise<SparePartDetails> {
    const listView = this.defaultSpareView(view);
    if (spare.page > 0) await this.goToLinkedSparesPage(listView, spare.page);
    const row = await this.findExactSpareRow(listView.list, spare);
    await this.revealSpareGridColumn(/^Part Code$/i, listView.list);
    const identity = row.getByText(spare.partCode || spare.partName, { exact: true }).first();
    await (await identity.count() ? identity : row).click();
    const dialog = this.page.getByRole('dialog').filter({ hasText: /Linked Components|Spare Part Details/i }).filter({ visible: true }).last();
    await expect(dialog, 'The Spare Part Details popup should open').toBeVisible({ timeout: 15_000 });
    // The popup renders its frame before the record arrives; wait for a Part Code value, not a fixed delay.
    await expect.poll(async () => {
      const details = await this.readSparePartDetails(dialog).catch(() => undefined);
      return Boolean(details?.partCode) && !/Loading\.\.\./i.test(await dialog.innerText().catch(() => ''));
    }, { timeout: 10_000 }).toBe(true).catch(() => undefined);
    return this.readSparePartDetails(dialog);
  }

  /**
   * Parses the Spare Part Details popup text. Labels and values are separate
   * elements; the Basic Information block shows label then value, while the
   * Stock & Inventory block shows the figure above its label, so the order is
   * detected rather than assumed.
   */
  public async readSparePartDetails(dialog: Locator): Promise<SparePartDetails> {
    const lines = (await dialog.innerText()).split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const flat = lines.join(' ');
    const blank = (value: string | undefined) => (value && !/^[-—–]$/.test(value.trim()) ? value.trim() : '');
    const isLabel = (line: string) => /^(?:Part Code|Part Name|Part Number|Spare Category|Optimum Qty|Unit|Maker|Maker Reference|Drawing Number|Critical|Rotation Item|Linked Components\b.*|Stock\s*&\s*Inventory|Total ROB|Minimum Level|Stock Status|Stock by Location|IHM Information|Basic Information|Close)$/i.test(line);
    const after = (label: RegExp, until: string) => {
      const index = lines.findIndex((line) => label.test(line));
      if (index >= 0 && lines[index + 1] && !isLabel(lines[index + 1])) return blank(lines[index + 1]);
      return blank(flat.match(new RegExp(`${label.source.replace(/^\^|\$$/g, '')}\\s+(.+?)\\s+(?:${until})\\b`, 'i'))?.[1]);
    };
    const partCode = after(/^Part Code$/i, 'Part Name');
    const partName = after(/^Part Name$/i, 'Part Number|Spare Category|Optimum Qty|Maker|Critical|Linked Components');

    const linkedIndex = lines.findIndex((line) => /^Linked Components\b/i.test(line));
    const linkedCountText = (linkedIndex >= 0 ? lines[linkedIndex] : flat).match(/Linked Components\s*\((\d+)\)/i)?.[1];
    const endIndex = lines.findIndex((line, index) => index > linkedIndex && /^(?:Stock\s*&\s*Inventory|Stock by Location|IHM Information|Close)$/i.test(line));
    const linkedComponentTexts = linkedIndex >= 0
      ? lines.slice(linkedIndex + 1, endIndex > linkedIndex ? endIndex : undefined)
      : [];

    const stockIndex = lines.findIndex((line) => /^Stock\s*&\s*Inventory$/i.test(line));
    const labelFirst = stockIndex >= 0 && isLabel(lines[stockIndex + 1] ?? '');
    const stockText = flat.match(/Stock\s*&\s*Inventory\s+(.*?)(?:\s+Stock by Location\b|\s+IHM Information\b|$)/i)?.[1] ?? '';
    const stockValue = (label: RegExp) => {
      if (stockIndex < 0) return '';
      const index = lines.findIndex((line, position) => position > stockIndex && label.test(line));
      if (index >= 0) {
        const candidate = labelFirst ? lines[index + 1] : lines[index - 1];
        return candidate && !isLabel(candidate) ? blank(candidate) : '';
      }
      // Label and figure rendered on one line, e.g. "5 Total ROB".
      const name = label.source.replace(/^\^|\$$/g, '');
      return blank(stockText.match(new RegExp(`(\\S+)\\s+${name}\\b`, 'i'))?.[1]
        ?? stockText.match(new RegExp(`${name}\\s+(\\S+)`, 'i'))?.[1]);
    };
    return {
      dialog,
      title: lines[0] ?? '',
      partCode,
      partName,
      linkedComponentsShown: linkedIndex >= 0,
      linkedCount: linkedCountText === undefined ? undefined : Number(linkedCountText),
      linkedComponentTexts,
      stockSectionShown: stockIndex >= 0,
      totalRob: stockValue(/^Total ROB$/i),
      minimumLevel: stockValue(/^Minimum Level$/i),
      stockStatus: stockValue(/^Stock Status$/i),
    };
  }

  public async openSpareLocationBreakdown(spare: ComponentSpareRow & { page?: number }, container?: Locator, listView?: SpareListView): Promise<SpareLocationBreakdown> {
    const scope = container ?? this.linkedSparesSection();
    if (spare.page && listView) await this.goToLinkedSparesPage(listView, spare.page);
    const root = await this.spareGridRoot(scope);
    const identity = await this.findExactSpareRowIdentity(scope, spare);
    await this.revealSpareGridColumn(/^Location$/i, scope);
    const row = this.spareRowFromIdentity(root, identity);
    const view = row.getByRole('button', { name: /^View(?:\s*\(\d+\))?$/i }).or(row.getByRole('link', { name: /^View(?:\s*\(\d+\))?$/i })).filter({ visible: true }).first();
    await expect(view, `Spare ${spare.partCode || spare.partName} should display View in Location`).toBeVisible();
    const viewLabel = (await view.innerText()).replace(/\s+/g, ' ').trim();
    await view.click();
    const dialog = this.page.getByRole('dialog').filter({ hasText: /Storage Locations/i }).filter({ visible: true }).last();
    await expect(dialog, 'The Storage Locations popup should open').toBeVisible();
    const totalText = (await dialog.getByText(/Total ROB/i).last().locator('xpath=..').innerText()).replace(/\s+/g, ' ').trim();
    const totalRob = totalText.match(/Total ROB\s*:?\s*([-+]?\d[\d,.]*)/i)?.[1] ?? '';
    const expectedLocationCount = Number(viewLabel.match(/\((\d+)\)/)?.[1] ?? 0);
    const readLocations = async (): Promise<{ location: string; quantity: string }[]> => {
      const grid = dialog.locator('[role="grid"], table').filter({ visible: true }).first();
      if (await grid.count()) {
        const headers = (await grid.locator('[role="columnheader"], thead th').allInnerTexts()).map((value) => value.trim());
        const locationIndex = Math.max(headers.findIndex((value) => /location/i.test(value)), 0);
        const quantityIndex = headers.findIndex((value) => /quantity|qty|rob/i.test(value));
        const tableLocations: { location: string; quantity: string }[] = [];
        const rows = grid.locator('[role="row"][row-id], tbody tr');
        for (let index = 0; index < await rows.count(); index += 1) {
          const values = (await rows.nth(index).locator('[role="gridcell"], td').allInnerTexts()).map((value) => value.replace(/\s+/g, ' ').trim());
          if (values.length) tableLocations.push({ location: values[locationIndex] ?? '', quantity: values[quantityIndex >= 0 ? quantityIndex : values.length - 1] ?? '' });
        }
        if (tableLocations.length) return tableLocations;
      }

      return dialog.evaluate((root) => {
        const clean = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
        const quantityPattern = /^[-+]?\d[\d,.]*(?:\.\d+)?\s*units?$/i;
        const elements = [...root.querySelectorAll<HTMLElement>('*')];
        const quantityLeaves = elements.filter((element) => {
          const own = clean(element.innerText);
          return quantityPattern.test(own)
            && ![...element.children].some((child) => quantityPattern.test(clean((child as HTMLElement).innerText)));
        });
        const results: { location: string; quantity: string }[] = [];
        const seen = new Set<string>();
        for (const quantityNode of quantityLeaves) {
          const quantity = clean(quantityNode.innerText);
          let card: HTMLElement | null = quantityNode.parentElement;
          while (card && card !== root) {
            const lines = card.innerText.split(/\r?\n/).map(clean).filter(Boolean);
            const other = lines.filter((line) => !quantityPattern.test(line)
              && !/^(?:Storage Locations|Location|Quantity|Qty|Total ROB|Close)$/i.test(line));
            if (other.length) {
              const location = clean(other.join(' > '));
              const key = `${location}\u0000${quantity}`;
              if (!seen.has(key)) {
                seen.add(key);
                results.push({ location, quantity });
              }
              break;
            }
            card = card.parentElement;
          }
        }
        return results;
      });
    };

    let locations: { location: string; quantity: string }[] = [];
    await expect.poll(async () => {
      locations = await readLocations();
      return locations.length;
    }, {
      message: expectedLocationCount
        ? `${viewLabel} should render ${expectedLocationCount} storage-location entries`
        : 'The Storage Locations popup should render its location entries',
      timeout: 10_000,
    }).toBe(expectedLocationCount || 1).catch(() => undefined);

    if (!locations.length || (expectedLocationCount && locations.length !== expectedLocationCount)) {
      const observed = locations.map((item) => `${item.location}: ${item.quantity}`).join('; ') || 'no location cards or table rows were extracted';
      throw new Error(`Observed Application Result:\nThe Storage Locations popup opened for spare ${spare.partCode || spare.partName} and showed Total ROB ${totalRob || '[missing]'}, but ${viewLabel} indicated ${expectedLocationCount || 'one or more'} location(s) and ${locations.length} were extracted (${observed}).`);
    }
    await this.closeSparePopup(dialog);
    return { spare, viewLabel, locations, totalRob };
  }

  /**
   * What this does: Opens the add-component form so a new item can be created.
   * When it's used: In tests that create a component.
   * @returns The component form page object.
   */
  public async openComponentForAdd(): Promise<ComponentFormPage> {
    const selectedVessel = (await this.vesselDropdown.textContent() ?? '').trim();
    await this.page
      .getByRole('button', {
        name: 'Add Component',
        exact: true,
      })
      .click();

    return new ComponentFormPage(this.page, selectedVessel);
  }

  /**
   * What this does: Finds the row for a component code by filtering the list and returning the matching locator.
   * When it's used: When a test needs to edit or verify a specific component.
   * @param code - The component code to search for.
   * @returns The matching row locator for the component.
   */
  public async findRowByCode(
    code: string,
  ): Promise<Locator> {
    /*
     * Expand the tree using the same generic logic used
     * by the Components validation.
     */
    await this.expandAll();

    await this.page
      .getByPlaceholder(
        'Search by Name, SFI Code, Fleet Equipment Code, Maker, or Se...',
      )
      .fill(code);

    await expect
      .poll(
        () =>
          this.page.getByText(code, {
            exact: true,
          }).count(),
        `Component ${code} should appear in the refreshed list`,
      )
      .toBeGreaterThan(0);

    return this.page
      .getByText(code, {
        exact: true,
      })
      .last();
  }

  /**
   * What this does: Opens the edit form for a selected component row.
   * When it's used: After finding a component in the list and choosing to update it.
   * @param row - The component row to open.
   * @returns The component form page object ready for editing.
   */
  public async openRowForEdit(
    row: Locator,
  ): Promise<ComponentFormPage> {
    await row.click();

    await expect(
      this.page.getByRole('button', {
        name: 'Edit Component',
        exact: true,
      }),
    ).toBeVisible();

    await this.page
      .getByRole('button', {
        name: 'Edit Component',
        exact: true,
      })
      .click();

    const selectedVessel = (await this.vesselDropdown.textContent() ?? '').trim();
    return new ComponentFormPage(this.page, selectedVessel);
  }

  /** Selects an exact component through the expandable filtered tree and opens Edit Component. */
  public async openComponentForEdit(code: string): Promise<ComponentFormPage> {
    await this.searchAndSelectComponentByCode(code);
    const editButton = this.page.getByRole('button', { name: 'Edit Component', exact: true });
    await expect(editButton).toBeVisible();
    await editButton.click();
    return new ComponentFormPage(this.page, (await this.vesselDropdown.textContent() ?? '').trim());
  }

  /** Opens Edit Component for the exact row already selected through the live hierarchy. */
  public async openSelectedComponentForEdit(): Promise<ComponentFormPage> {
    const editButton = this.page.getByRole('button', { name: 'Edit Component', exact: true });
    await expect(editButton, 'The selected component should expose Edit Component').toBeVisible();
    await editButton.click();
    return new ComponentFormPage(this.page, (await this.vesselDropdown.textContent() ?? '').trim());
  }

  /** Deletes the currently selected disposable component from its details header. */
  public async deleteSelectedComponent(code: string): Promise<string> {
    const vesselName = (await this.vesselDropdown.textContent() ?? '').trim();
    await this.waitForSelectedComponent(code);
    const deleteButton = this.page.getByTestId('btn-delete-component');
    await expect(
      deleteButton,
      `The selected disposable Component ${code} should expose its delete action`,
    ).toBeVisible();
    await deleteButton.click();

    const cannotDeleteHeading = this.page.getByText('Cannot Delete Component', { exact: true });
    const linkedJobsDialog = this.page.getByRole('dialog').filter({ has: cannotDeleteHeading })
      .filter({ hasText: LINKED_JOBS_MESSAGE }).last();
    // The linked-jobs popup also mentions "delete", so exclude it from the confirmation locator.
    const dialog = this.page.getByRole('dialog').filter({ hasText: /delete|remove/i })
      .filter({ hasNot: cannotDeleteHeading }).last();
    const blockedBeforeConfirm = await Promise.race([
      dialog.waitFor({ state: 'visible' }).then(() => false),
      linkedJobsDialog.waitFor({ state: 'visible' }).then(() => true),
    ]).catch(() => false);
    if (blockedBeforeConfirm) return this.acknowledgeLinkedJobsPopup(linkedJobsDialog, vesselName);
    await expect(dialog, `Component ${code} deletion confirmation should open`).toBeVisible();
    const confirmButton = dialog
      .getByRole('button', { name: /^(delete|confirm|yes(?:,? delete)?)$/i })
      .last();
    const deletionResponse = this.page.waitForResponse(
      (response) =>
        response.url().includes('/technical/api/components') &&
        response.request().method() === 'DELETE',
    );
    // The losing branch of the race below must not surface as an unhandled rejection.
    deletionResponse.catch(() => undefined);
    await confirmButton.click();
    const linkedJobsPopupShown = linkedJobsDialog.waitFor({ state: 'visible' }).then(() => true, () => false);
    type DeleteOutcome = { response: Response } | { blocked: true };
    const awaitResponse = (): Promise<DeleteOutcome> => deletionResponse.then((response) => ({ response }));
    const outcome = await Promise.race<DeleteOutcome>([
      awaitResponse(),
      linkedJobsPopupShown.then((shown): DeleteOutcome | Promise<DeleteOutcome> => (shown ? { blocked: true } : awaitResponse())),
    ]);
    if ('blocked' in outcome) return this.acknowledgeLinkedJobsPopup(linkedJobsDialog, vesselName);
    const { response } = outcome;
    if (!response.ok()) {
      if (await linkedJobsDialog.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false)) {
        return this.acknowledgeLinkedJobsPopup(linkedJobsDialog, vesselName);
      }
      const notFoundDialog = this.page.getByRole('dialog').filter({
        has: this.page.getByText('Cannot Delete Component', { exact: true }),
      }).filter({
        has: this.page.getByText('Component not found', { exact: true }),
      }).last();
      const exactNotFoundPopupVisible = await notFoundDialog
        .waitFor({ state: 'visible', timeout: 3_000 })
        .then(() => true)
        .catch(() => false);
      if (exactNotFoundPopupVisible) {
        const okButton = notFoundDialog.getByRole('button', { name: 'OK', exact: true });
        await expect(okButton, 'The Component not found popup should provide an OK button').toBeVisible();
        await okButton.click();
        await expect(notFoundDialog, 'The Component not found popup should close after OK').toBeHidden();
        await this.page.reload({ waitUntil: 'domcontentloaded' });
        await this.expectToBeOnPage();
        await this.selectVessel(vesselName);
        await this.expectTreeLoaded();
        throw new ComponentNotFoundDuringDeletionError(
          `Cannot Delete Component — Component not found (HTTP ${response.status()}). The popup was acknowledged and the Components register was refreshed.`,
        );
      }
      expect(response.ok(), `Component ${code} deletion should succeed`).toBe(true);
    }

    const feedback = this.page
      .getByText(/component .*deleted|deleted successfully|successfully deleted/i)
      .filter({ visible: true })
      .last();
    return await feedback.isVisible().catch(() => false)
      ? (await feedback.innerText()).replace(/\s+/g, ' ').trim()
      : `Component ${code} deletion completed with HTTP ${response.status()}.`;
  }

  /**
   * Captures the "Cannot Delete Component" linked-jobs popup message, clicks OK,
   * waits for it to close, refreshes Components on the same vessel, and throws
   * ComponentBlockedByLinkedJobsError. Linked jobs are never changed.
   */
  private async acknowledgeLinkedJobsPopup(linkedJobsDialog: Locator, vesselName: string): Promise<never> {
    const popupMessage = (await linkedJobsDialog.getByText(LINKED_JOBS_MESSAGE).first().innerText())
      .replace(/\s+/g, ' ').trim();
    const jobCount = popupMessage.match(/has (\d+) active Job\(s\)/i)?.[1];
    const okButton = linkedJobsDialog.getByRole('button', { name: 'OK', exact: true });
    await expect(okButton, 'The linked-jobs Cannot Delete Component popup should provide an OK button').toBeVisible();
    await okButton.click();
    await expect(linkedJobsDialog, 'The linked-jobs Cannot Delete Component popup should close after OK').toBeHidden();
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    await this.expectToBeOnPage();
    await this.selectVessel(vesselName);
    await this.expectTreeLoaded();
    throw new ComponentBlockedByLinkedJobsError(popupMessage, jobCount === undefined ? undefined : Number(jobCount));
  }

  /**
   * Confirms a deleted component cannot be resolved and that no stale or
   * cross-vessel component details have been substituted in its place.
   */
  public async expectDeletedComponentUnavailable(
    code: string,
    vesselName: string,
  ): Promise<string> {
    await this.clearComponentSearch();
    await this.expectVesselSelected(vesselName);
    await this.enterSearchText(code);

    const escapedCode = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matchingRow = this.componentRows.filter({
      hasText: new RegExp(`^${escapedCode}(?:\\s|$)`),
    });
    await expect(
      matchingRow,
      `Deleted Component ${code} should not remain in the Components tree`,
    ).toHaveCount(0);
    await expect(
      this.page.getByRole('heading', {
        level: 3,
        name: new RegExp(`^${escapedCode}(?:\\s|$)`),
      }),
      `Deleted Component ${code} should not remain selected`,
    ).toHaveCount(0);

    const neutralDetails = this.page.getByText(
      /select a component to view details|component not found|no components? found|no data/i,
    ).filter({ visible: true });
    await expect(
      neutralDetails.first(),
      `The application should explain that Component ${code} is unavailable`,
    ).toBeVisible();

    const visibleVesselValues = this.page
      .getByText('Vessel Name', { exact: true })
      .filter({ visible: true });
    await expect(
      visibleVesselValues,
      'No stale or cross-vessel component detail panel should be displayed',
    ).toHaveCount(0);

    return (await neutralDetails.first().innerText()).replace(/\s+/g, ' ').trim();
  }

  /**
   * Filters the tree with a full or partial term and proves that one exact
   * deleted identity is absent without assuming all partial results are empty.
   */
  public async expectComponentAbsentFromSearch(
    searchTerm: string,
    deletedComponentCode: string,
    vesselName: string,
  ): Promise<ComponentAbsenceSearchResult> {
    await this.expectVesselSelected(vesselName);
    await this.enterSearchText(searchTerm);
    await expect(
      this.componentCountLabel.locator('..').locator('[aria-busy="true"]'),
      `Search ${searchTerm} should finish loading`,
    ).toHaveCount(0);

    const escapedCode = deletedComponentCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const exactCode = new RegExp(`^${escapedCode}(?:\\s|$)`);
    const exactMatches = this.componentRows.filter({ hasText: exactCode });
    await expect(
      exactMatches,
      `Deleted Component ${deletedComponentCode} must be absent for search ${searchTerm}`,
    ).toHaveCount(0);
    await expect(
      this.page.getByTestId('B7').getByRole('heading', { level: 3, name: exactCode }),
      `Deleted Component ${deletedComponentCode} must not remain open`,
    ).toHaveCount(0);

    const selectedDetailsHeading = this.page.getByTestId('B7').getByTestId('B7.1').filter({ visible: true });
    await expect(
      selectedDetailsHeading,
      `Search ${searchTerm} must not substitute another Component details panel`,
    ).toHaveCount(0);
    await expect(
      this.page.getByTestId('B7').getByText('Vessel Name', { exact: true }).filter({ visible: true }),
      `Search ${searchTerm} must not expose stale or cross-vessel details`,
    ).toHaveCount(0);

    const visibleResultCount = await this.componentRows.count();
    const feedbackLocator = this.page.getByTestId('B7')
      .getByText(/select a component to view details|component not found|no components? found|no data/i)
      .filter({ visible: true })
      .first();
    const feedback = await feedbackLocator.isVisible().catch(() => false)
      ? (await feedbackLocator.innerText()).replace(/\s+/g, ' ').trim()
      : `${visibleResultCount} unrelated filtered tree row(s) remained visible.`;
    return {
      searchTerm,
      visibleResultCount,
      exactComponentMatches: 0,
      feedback,
    };
  }

  /** Verifies the uniquely filtered left Components panel is empty. */
  public async expectFilteredTreeEmpty(searchTerm: string): Promise<void> {
    await expect(
      this.page.getByTestId('B6').locator('[aria-busy="true"]'),
      `Components tree search ${searchTerm} should finish loading`,
    ).toHaveCount(0);
    await expect(
      this.componentRows,
      `Left Components tree should be empty for unique deleted search ${searchTerm}`,
    ).toHaveCount(0);
  }

  /** Verifies the right details panel is neutral and has no substituted record. */
  public async expectEmptyComponentDetails(): Promise<void> {
    const rightPanel = this.page.getByTestId('B7');
    await expect(
      rightPanel.getByText('Select a component to view details', { exact: true }),
      'Right details panel should request a component selection',
    ).toBeVisible();
    await expect(rightPanel.getByTestId('B7.1')).toHaveCount(0);
  }

  /** Clears an empty-result filter and proves the normal vessel tree is usable. */
  public async clearSearchAndExpectNormalTree(): Promise<void> {
    await this.clearComponentSearch();
    await this.expectTreeLoaded();
  }

  /** Resets the controls shared by the tree/search/filter scenarios. */
  public async resetTreeFilters(): Promise<void> {
    await this.clearComponentSearch();
    const criticalFilter = this.page.getByText('Critical Item:', { exact: true })
      .locator('..').getByRole('combobox');
    if (!/All Items/i.test(await criticalFilter.textContent() ?? '')) {
      await criticalFilter.click();
      await this.page.getByRole('option', { name: 'All Items', exact: true }).click();
    }
    await expect(this.page.getByTestId('B6').locator('[aria-busy="true"]')).toHaveCount(0);
    await this.expectTreeLoaded();
  }

  /** Applies one of the application's Critical Item choices and waits for settled results. */
  public async applyCriticalFilter(value: 'All Items' | 'Critical Only' | 'Non-Critical'): Promise<void> {
    const criticalFilter = this.page.getByText('Critical Item:', { exact: true })
      .locator('..').getByRole('combobox');
    await criticalFilter.click();
    await this.page.getByRole('option', { name: value, exact: true }).click();
    await expect(criticalFilter, `Critical Item should be ${value}`).toContainText(value);
    await expect(this.page.getByTestId('B6').locator('[aria-busy="true"]')).toHaveCount(0);
  }

  /** Returns the Critical Item filter value currently displayed by the application. */
  public async criticalFilterValue(): Promise<string> {
    return (await this.page.getByText('Critical Item:', { exact: true })
      .locator('..').getByRole('combobox').textContent() ?? '').trim();
  }

  /** Uses the register-level Expand or Collapse control. */
  public async setWholeTreeExpanded(expanded: boolean): Promise<void> {
    const button = this.page.getByRole('button', { name: expanded ? 'Expand' : 'Collapse', exact: true });
    await expect(button).toBeVisible();
    await button.click();
    await expect(this.page.getByTestId('B6').locator('[aria-busy="true"]')).toHaveCount(0);
    await expect(this.componentRows.first()).toBeVisible();
  }

  /** Enters a tree search term and returns the rendered hierarchy after loading settles. */
  public async searchTree(term: string): Promise<ComponentTreeRow[]> {
    await this.enterSearchText(term);
    await expect(this.page.getByTestId('B6').locator('[aria-busy="true"]'), `Search ${term} should settle`).toHaveCount(0);
    return this.readExpandedTreeRows();
  }

  /** Derives a reusable parent/child fixture from the configured component and live tree. */
  public async discoverHierarchyFixture(leafCode: string): Promise<ComponentHierarchyFixture> {
    await this.resetTreeFilters();
    // Filtering preserves the matching ancestry. The existing selector expands
    // only the required branches, which makes the parent relationship reliable
    // even when the unfiltered register virtualizes most descendants.
    await this.searchAndSelectComponentByCode(leafCode);
    const rows = await this.readExpandedTreeRows();
    const leafIndex = rows.findIndex((row) => row.code === leafCode);
    expect(leafIndex, `Configured Component ${leafCode} should exist in the expanded tree`).toBeGreaterThanOrEqual(0);
    const leaf = rows[leafIndex];
    let parentIndex = leafIndex - 1;
    while (parentIndex >= 0 && rows[parentIndex].depth >= leaf.depth) parentIndex -= 1;
    expect(parentIndex, `Component ${leafCode} should have a displayed parent`).toBeGreaterThanOrEqual(0);
    const parent = rows[parentIndex];
    const directChildren: ComponentTreeRow[] = [];
    for (let index = parentIndex + 1; index < rows.length && rows[index].depth > parent.depth; index += 1) {
      if (rows[index].depth === parent.depth + 1) directChildren.push(rows[index]);
    }
    expect(directChildren.some((row) => row.code === leafCode), `${leafCode} should be a direct child of ${parent.code}`).toBe(true);
    await this.resetTreeFilters();
    await this.setWholeTreeExpanded(false);
    const topLevel = (await this.readExpandedTreeRows()).filter((row) => row.depth === 0);
    return { parent, leaf, directChildren, topLevel };
  }

  /** Uses the row chevron to force a parent into expanded or collapsed state. */
  public async setParentExpanded(parentCode: string, expanded: boolean): Promise<void> {
    const pattern = new RegExp(`^${parentCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);
    const row = await this.findRenderedComponentRow(pattern, parentCode);
    await expect(row, `Parent ${parentCode} should be rendered`).toHaveCount(1);
    const desiredIcon = expanded ? 'svg.lucide-chevron-down' : 'svg.lucide-chevron-right';
    if (!(await row.locator(desiredIcon).isVisible().catch(() => false))) {
      await row.getByRole('button').first().click();
    }
    await expect(row.locator(desiredIcon), `Parent ${parentCode} should be ${expanded ? 'expanded' : 'collapsed'}`).toBeVisible();
  }

  /** Returns direct children for a rendered component without treating a leaf as an error. */
  public async directChildCodes(parentCode: string): Promise<string[]> {
    const pattern = new RegExp(`^${parentCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);
    const row = await this.findRenderedComponentRow(pattern, parentCode);
    await expect(row, `Component ${parentCode} should be rendered before checking children`).toHaveCount(1);
    const collapsed = row.locator('svg.lucide-chevron-right');
    const expanded = row.locator('svg.lucide-chevron-down');
    if (!(await collapsed.isVisible().catch(() => false)) && !(await expanded.isVisible().catch(() => false))) return [];
    if (await collapsed.isVisible().catch(() => false)) {
      await row.getByRole('button').first().click();
      await this.waitForTreeToSettle(`Component ${parentCode} children should settle after expansion`);
    }
    const rows = await this.readExpandedTreeRows();
    const parentIndex = rows.findIndex((item) => item.code === parentCode);
    if (parentIndex < 0) return [];
    const parentDepth = rows[parentIndex].depth;
    const children: string[] = [];
    for (const item of rows.slice(parentIndex + 1)) {
      if (item.depth <= parentDepth) break;
      if (item.depth === parentDepth + 1) children.push(item.code);
    }
    return children;
  }

  /** Returns whether a component row currently exists in the filtered tree. */
  public async treeContainsCode(code: string): Promise<boolean> {
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return (await this.componentRows.filter({ hasText: new RegExp(`^${escaped}(?:\\s|$)`) }).count()) > 0;
  }

  public async exactComponentCount(code: string, maxExpansions = 100): Promise<number> {
    await this.clearComponentSearch();
    await this.enterSearchText(code);
    await this.waitForTreeToSettle(`The Components search for ${code} should settle`);
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const exactRows = this.componentRows.filter({ hasText: new RegExp(`^${escaped}(?:\\s|$)`) });
    for (let expansion = 0; expansion < maxExpansions; expansion += 1) {
      const collapsedRow = this.componentRows
        .filter({ has: this.page.locator('svg.lucide-chevron-right.text-gray-600') })
        .first();
      if (!(await collapsedRow.isVisible().catch(() => false))) {
        const distinctRows = new Set(
          (await exactRows.allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim()),
        );
        return distinctRows.size;
      }
      const rowText = (await collapsedRow.innerText()).replace(/\s+/g, ' ').trim();
      const stableRow = this.componentRows.filter({
        hasText: new RegExp(`^${rowText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
      }).first();
      await stableRow.getByRole('button').first().click();
      await expect(
        stableRow.locator('svg.lucide-chevron-right'),
        `Filtered branch ${rowText} should expand while locating ${code}`,
      ).toBeHidden();
      await expect(this.page.getByTestId('B6').locator('[aria-busy="true"]')).toHaveCount(0);
    }
    throw new Error(`Component search for ${code} exceeded the safe ${maxExpansions}-expansion limit.`);
  }

  /** Fully expands a filtered hierarchy before counting an exact code; intended for cleanup verification. */
  public async exactComponentCountFullyLoaded(code: string, levels = 8): Promise<number> {
    await this.clearComponentSearch();
    await this.searchTree(code);
    await this.expandTreeLevels(levels);
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return this.componentRows.filter({ hasText: new RegExp(`^${escaped}(?:\\s|$)`) }).count();
  }

  private async waitForTreeToSettle(message: string): Promise<void> {
    let lastTree: string | undefined;
    let stableChecks = 0;
    await expect.poll(
      async () => {
        if (await this.page.getByTestId('B6').locator('[aria-busy="true"]').count()) {
          stableChecks = 0;
          return false;
        }
        const currentTree = (await this.componentRows.allInnerTexts()).join('\n');
        stableChecks = currentTree === lastTree ? stableChecks + 1 : 0;
        lastTree = currentTree;
        return stableChecks >= 2;
      },
      { message, timeout: 10_000, intervals: [100, 200, 300, 500] },
    ).toBe(true);
  }

  /** Lists automation-looking rows for reporting only; it never selects or deletes them. */
  public async listAutomationLookingComponents(): Promise<AutomationLookingComponent[]> {
    const found = new Map<string, AutomationLookingComponent>();
    for (const term of ['AT0', 'AUTO-CMP', 'Disposable', 'Test CMP']) {
      await this.clearComponentSearch();
      const unfilteredTree = (await this.componentRows.allInnerTexts()).join('\n');
      await this.enterSearchText(term);
      await expect.poll(
        async () => {
          if (await this.page.getByTestId('B6').locator('[aria-busy="true"]').count()) return unfilteredTree;
          return (await this.componentRows.allInnerTexts()).join('\n');
        },
        { message: `Automation inventory search ${term} should settle`, timeout: 30_000 },
      ).not.toBe(unfilteredTree);

      for (let expansion = 0; expansion < 200; expansion += 1) {
        const collapsedRow = this.componentRows
          .filter({ has: this.page.locator('svg.lucide-chevron-right.text-gray-600') })
          .first();
        if (!(await collapsedRow.isVisible().catch(() => false))) break;
        const rowText = (await collapsedRow.innerText()).replace(/\s+/g, ' ').trim();
        const stableRow = this.componentRows.filter({
          hasText: new RegExp(`^${rowText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
        }).first();
        await stableRow.getByRole('button').first().click();
        await expect(
          stableRow.locator('svg.lucide-chevron-right'),
          `Filtered branch ${rowText} should expand`,
        ).toBeHidden();
        await expect(this.page.getByTestId('B6').locator('[aria-busy="true"]')).toHaveCount(0);
      }
      const rows = await this.readExpandedTreeRows();
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const automationCode = /^AT\d{3}-[A-Z0-9]{4}$/i.test(row.code)
          || /^AUTO-CMP\d{3}-[A-Z0-9]+$/i.test(row.code);
        const automationName = /^Test CMP\d{3}\s+[A-Z0-9]{4}$/i.test(row.name)
          || /CMP\d{3}\s+Disposable/i.test(row.name);
        if (automationCode || automationName) {
          let parentCode = '';
          for (let parentIndex = index - 1; parentIndex >= 0; parentIndex -= 1) {
            if (rows[parentIndex].depth < row.depth) {
              parentCode = rows[parentIndex].code;
              break;
            }
          }
          found.set(row.code, { code: row.code, name: row.name, parentCode });
        }
      }
    }
    await this.clearComponentSearch();
    return [...found.values()];
  }

  /** Reads the current Critical Item value for the selected component. */
  public async selectedComponentCriticality(): Promise<string> {
    return this.readSelectedComponentDetail({ section: 'A. Component Information', label: 'Critical Item' });
  }
}

function parseWorkOrderResponse(body: string): { workOrderNumber: string; status: string; message: string } {
  try {
    const value: unknown = JSON.parse(body);
    const strings = new Map<string, string>();
    const visit = (item: unknown, path = ''): void => {
      if (typeof item === 'string' || typeof item === 'number') strings.set(path.toLowerCase(), String(item));
      else if (Array.isArray(item)) item.forEach((child, index) => visit(child, `${path}.${index}`));
      else if (item && typeof item === 'object') Object.entries(item as Record<string, unknown>).forEach(([key, child]) => visit(child, path ? `${path}.${key}` : key));
    };
    visit(value);
    const find = (patterns: RegExp[]) => [...strings.entries()].find(([key]) => patterns.some((pattern) => pattern.test(key)))?.[1] ?? '';
    return {
      workOrderNumber: find([/(?:workorder|work_order|wo)(?:no|number|_no|_number)$/i, /workordernumber/i]),
      status: find([/(?:^|\.)status$/i, /workorderstatus/i]),
      message: find([/(?:^|\.)message$/i]),
    };
  } catch {
    return { workOrderNumber: '', status: '', message: body.trim() };
  }
}

/**
 * Reads headers and rows in one browser call. ag-grid renders pinned columns
 * (such as ROB) in separate containers, so header and cell DOM order differ and
 * one logical row is split across several row elements sharing a row-id. Cells
 * are therefore matched to headers by col-id / aria-colindex, fragments are
 * merged by row-id, and rows keep their displayed row-index order.
 *
 * ag-grid also virtualises columns: in the F. Spares grid and the separate
 * PMS → Spares module grid only the columns inside the visible width exist in
 * the DOM, so Stock and later columns are absent until the grid is scrolled right. With `allColumns`, the grid is
 * scrolled across its full width, every rendered column is merged per row-id,
 * and the original scroll position is restored.
 */
export async function snapshotSpareGrid(grid: Locator, allColumns = true): Promise<SpareGridSnapshot> {
  return grid.evaluate(async (root, scanColumns) => {
    type Cell = SpareGridSnapshot['rows'][number]['cells'][number];
    const clean = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    const text = (node: { textContent: string | null }) => clean((node as { innerText?: string }).innerText ?? node.textContent);
    // A column is identified by col-id, then aria-colindex; DOM position is only meaningful for plain tables.
    const columnKey = (node: Element, position: number) =>
      node.getAttribute('col-id') || node.getAttribute('aria-colindex')
        ? `${node.getAttribute('col-id') ?? ''}|${node.getAttribute('aria-colindex') ?? ''}`
        : `position:${position}`;
    const headers = new Map<string, SpareGridSnapshot['headers'][number]>();
    const byRow = new Map<string, { rowId: string; domIndex: number; rowIndex: number; cells: Map<string, Cell> }>();
    const collect = () => {
      root.querySelectorAll('[role="columnheader"], thead th').forEach((node, position) => {
        const key = columnKey(node, position);
        if (!headers.has(key)) {
          headers.set(key, { colId: node.getAttribute('col-id') ?? '', colIndex: node.getAttribute('aria-colindex') ?? '', position, text: text(node) });
        }
      });
      root.querySelectorAll('[role="row"][row-id], tbody tr').forEach((row, domIndex) => {
        const rowId = row.getAttribute('row-id') ?? '';
        const key = rowId ? `id:${rowId}` : `dom:${domIndex}`;
        const entry = byRow.get(key) ?? { rowId, domIndex, rowIndex: Number(row.getAttribute('row-index') ?? domIndex), cells: new Map<string, Cell>() };
        row.querySelectorAll('[role="gridcell"], td').forEach((cell, position) => {
          const cellKey = columnKey(cell, position);
          const value = { colId: cell.getAttribute('col-id') ?? '', colIndex: cell.getAttribute('aria-colindex') ?? '', position, text: text(cell), title: clean(cell.getAttribute('title')) };
          // Keep a rendered value; a cell caught mid-render must not blank one read earlier.
          if (!entry.cells.get(cellKey)?.text || value.text) entry.cells.set(cellKey, value);
        });
        byRow.set(key, entry);
      });
    };
    collect();

    const gridNode = root.matches('[role="grid"]') ? root : root.querySelector('[role="grid"]');
    const columnCount = Number(gridNode?.getAttribute('aria-colcount') ?? 0);
    const scroller = root.querySelector<HTMLElement>('.ag-body-horizontal-scroll-viewport');
    const center = root.querySelector<HTMLElement>('.ag-center-cols-viewport');
    const horizontal = scroller && scroller.scrollWidth > scroller.clientWidth + 1 ? scroller : center;
    if (scanColumns && horizontal && horizontal.scrollWidth > horizontal.clientWidth + 1 && !(columnCount && headers.size >= columnCount)) {
      const rendered = () => [...root.querySelectorAll('[role="columnheader"], [role="gridcell"]')].map((node) => node.getAttribute('col-id')).join(',');
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      // Waits for ag-grid to render the columns of the new scroll position: the rendered set must change and then hold for one frame.
      const settle = async (before: string) => {
        let previous = before;
        let changed = false;
        for (let attempt = 0; attempt < 30; attempt += 1) {
          await frame();
          const now = rendered();
          if (changed && now === previous) return;
          if (now !== previous) changed = true;
          previous = now;
        }
      };
      const scrollTo = async (left: number) => {
        const before = rendered();
        horizontal.scrollLeft = left;
        if (center && center !== horizontal) center.scrollLeft = left;
        await settle(before);
      };
      const start = horizontal.scrollLeft;
      const max = horizontal.scrollWidth - horizontal.clientWidth;
      const stride = Math.max(horizontal.clientWidth * 0.75, 50);
      for (let left = 0; ; left = Math.min(left + stride, max)) {
        if (left !== horizontal.scrollLeft) await scrollTo(left);
        collect();
        if (left >= max || (columnCount && headers.size >= columnCount)) break;
      }
      if (horizontal.scrollLeft !== start) await scrollTo(start);
    }

    const rows = [...byRow.values()].sort((a, b) => a.rowIndex - b.rowIndex || a.domIndex - b.domIndex)
      .map(({ rowId, domIndex, cells }) => ({ rowId, domIndex, cells: [...cells.values()] }));
    return { headers: [...headers.values()], rows };
  }, allColumns);
}

/** Maps one merged grid row to spare values, matching cells to headers by col-id, then aria-colindex. */
export function spareRowFromSnapshot(snapshot: SpareGridSnapshot, row: SpareGridSnapshot['rows'][number]): ComponentSpareRow {
  const read = (patterns: RegExp[], colIds: string[]) => {
    const header = snapshot.headers.find((item) => patterns.some((pattern) => pattern.test(item.text)));
    const cell = header
      ? header.colId && row.cells.some((item) => item.colId)
        ? row.cells.find((item) => item.colId === header.colId)
        : header.colIndex && row.cells.some((item) => item.colIndex)
          ? row.cells.find((item) => item.colIndex === header.colIndex)
          : row.cells.find((item) => item.position === header.position)
      : row.cells.find((item) => colIds.includes(item.colId));
    return cell ? cell.text || (header ? '' : cell.title) : '';
  };
  return {
    partCode: read([/^part code$/i, /^code$/i], ['partCode', 'code']),
    partName: read([/^part name$/i, /^name$/i], ['partName', 'name']),
    componentName: read([/^component(?: name)?$/i], ['componentName']),
    partNumber: read([/^part number$/i], ['partNumber']),
    rob: read([/^rob$/i, /^total rob$/i], ['rob', 'totalRob']),
    min: read([/^min(?:imum)?$/i], ['min', 'minimum']),
    stock: read([/^stock$/i, /^status$/i], ['stock', 'stockStatus']),
    location: read([/^location$/i, /^storage location$/i], ['location', 'locations']),
  };
}
