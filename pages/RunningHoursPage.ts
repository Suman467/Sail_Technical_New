/* global document, HTMLElement */

import { expect, type Locator, type Page } from '@playwright/test';

import { config } from '../utils/config';
import { routes } from '../utils/routes';
import { BasePage } from './BasePage';
import { readAppNotification } from '../utils/appNotification';
import { runningHoursSaveAccepted } from '../utils/runningHoursValidation';

export type RunningHoursUiRow = {
  componentName: string;
  componentCode: string;
  componentCategory: string;
  runningHours: string;
  inheritedRh: string;
};

/** One Running Hours grid row read by column id, including its Last Updated value. */
export type RunningHoursGridRow = {
  rowIndex: number;
  componentName: string;
  componentCode: string;
  componentCategory: string;
  runningHours: string;
  lastUpdated: string;
  inheritedRh: string;
  rateLimit: string;
};

/** The Running Hours footer: "Showing N components" or, while filtered, "Showing N of T components". */
export type RunningHoursCount = { shown: number; total: number; text: string };

/** The rows and footer count shown after a Running Hours component search settles. */
export type RunningHoursSearchResult = RunningHoursCount & { rows: RunningHoursGridRow[] };
export type RunningHoursUpdateAction = 'Set Total' | 'Add Delta';
export type RunningHoursUpdateResult = {
  tooltip: string;
  feedback: string;
  saveEnabled: boolean;
  saveClicked: boolean;
  dialogClosed: boolean;
  responseStatus?: number;
  requestCompleted: boolean;
};
export type RunningHoursInheritedChild = {
  componentCode: string;
  name: string;
  currentCumulativeRH: string;
  lastUpdated: string | null;
  rhCounterType: string;
};
export type RunningHoursInheritedDetails = {
  indicator: string;
  details: string;
  children: RunningHoursInheritedChild[];
};
const inheritedChildrenByPage = new WeakMap<Page, Map<string, RunningHoursInheritedChild[]>>();
export type RunningHoursRejectedAttempt = {
  oldValue: string;
  attemptedValue: string;
  actualFieldValue: string;
  selectedDate: string;
  updateMode: RunningHoursUpdateAction;
  meterReplaced: boolean;
  saveEnabled: boolean;
  saveClicked: boolean;
  applicationValidation: string;
  automationError: string;
  feedback: string;
};
export type MeterReplacementConfirmationState = {
  title: string;
  instruction: string;
  componentName: string;
  componentCode: string;
  currentRh: string;
  actionType: string;
  reason: string;
  confirmationText: string;
};
export type PreparedMeterReplacementState = {
  oldMeterFinal: string;
  newMeterStart: string;
  meterReplaced: boolean;
  saveEnabled: boolean;
};
export type RunningHoursHistoryRecord = Record<string, string>;
export type BulkUpdateDiagnostic = {
  outcome: 'success' | 'application-error' | 'backend-error' | 'network-error' | 'stalled' | 'unconfirmed';
  submittedAt: string;
  observationWindowMs: number;
  elapsedMs: number;
  savingStateObserved: boolean;
  saveButtonText: string;
  saveButtonEnabled: boolean;
  dialogVisible: boolean;
  notifications: string[];
  validations: string[];
  requests: Array<{ method: string; url: string; status?: number; body?: string; failure?: string; state: 'completed' | 'failed' | 'pending' }>;
  consoleErrors: string[];
};

const COMPONENT_COUNT = /^Showing\s+([\d,]+)(?:\s+of\s+([\d,]+))?\s+components?$/;

/**
 * Models the Running Hours overview screen in the Technical > PMS module.
 * The page reads the rendered grid only; it does not call application APIs.
 */
export class RunningHoursPage extends BasePage {
  protected readonly path = routes.runningHours;
  protected readonly pageName = 'Running Hours';
  protected readonly pageLoadedIndicator: Locator;

  private readonly vesselDropdown: Locator;
  private readonly overviewTab: Locator;
  private readonly runningHoursTable: Locator;
  private readonly overviewDataRows: Locator;
  private readonly componentSearchField: Locator;
  private readonly componentCount: Locator;

  public constructor(page: Page) {
    super(page);

    this.pageLoadedIndicator = page.getByRole('heading', {
      name: 'Running Hours',
      exact: true,
    });

    this.vesselDropdown = page.getByRole('combobox').first();

    this.overviewTab = page
      .getByRole('tab', { name: 'Overview', exact: true })
      .or(page.getByRole('button', { name: 'Overview', exact: true }));

    // The application renders a role="grid", not a <table>.
    this.runningHoursTable = page.getByRole('grid').first();
    this.overviewDataRows = this.runningHoursTable.locator(
      '[role="row"]:has([role="cell"], [role="gridcell"], td)',
    );
    this.componentSearchField = page.getByPlaceholder('Search Component', { exact: true });
    this.componentCount = page.getByText(COMPONENT_COUNT);
  }

  /** Waits for the Running Hours heading without recording a report step. */
  public async waitForScreen(): Promise<void> {
    await expect(this.page, 'The Running Hours page should open').toHaveURL(new RegExp(`${routes.runningHours}(?:[?#]|$)`));
    await expect(this.pageLoadedIndicator, 'The Running Hours heading should be displayed').toBeVisible();
  }

  /** Returns the vessel currently shown in the Running Hours vessel selector once it has hydrated. */
  public async selectedVesselName(): Promise<string> {
    // Other PMS pages use the same selector position; never read or change theirs.
    await this.waitForScreen();
    let selected = '';
    await expect.poll(async () => {
      selected = (await this.vesselDropdown.textContent())?.trim() ?? '';
      return selected;
    }, { message: 'The Running Hours vessel selection should finish loading' }).not.toMatch(/^(?:select\s+vessel)?$/i);
    return selected;
  }

  /** Reads the vessel names offered by the selector and closes it again. */
  public async vesselOptions(): Promise<string[]> {
    await this.waitForScreen();
    await this.vesselDropdown.click();
    const options = this.page.getByRole('option').filter({ visible: true });
    await expect(options.first(), 'The Running Hours vessel list should open').toBeVisible();
    const names = [...new Set((await options.filter({ visible: true }).allInnerTexts()).map((name) => name.trim()).filter(Boolean))];
    await this.page.keyboard.press('Escape');
    await expect(options.first(), 'The Running Hours vessel list should close').toBeHidden();
    return names;
  }

  /**
   * Selects a vessel only when it is not already selected (returns undefined
   * then). The application requests a vessel's Running Hours only the first
   * time in a session and reuses that data afterwards, so the request is
   * awaited when it is made and its occurrence is returned.
   */
  public async selectVesselAndWaitForData(name: string): Promise<{ requested: boolean } | undefined> {
    if (await this.selectedVesselName() === name) return undefined;
    await this.vesselDropdown.click();
    const option = this.page.getByRole('option', { name, exact: true }).filter({ visible: true }).last();
    await expect(option, `Vessel ${name} should be offered in the Running Hours vessel list`).toBeVisible();
    const request = this.page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/technical/api/running-hours/parents')
      && response.request().method() === 'GET', { timeout: 5_000 }).then((response) => response, () => undefined);
    await option.click();
    const response = await request;
    expect(response?.ok() ?? true, `The Running Hours data request for Vessel ${name} should succeed`).toBe(true);
    await expect(this.vesselDropdown, `Vessel ${name} should be selected in Running Hours`).toHaveText(name);
    return { requested: Boolean(response) };
  }

  /**
   * Reads every Running Hours row by column id. The grid renders only the rows
   * in view, so its own scrolling body is scrolled from top to bottom and each
   * row is collected once by its row index.
   */
  public async readAllRows(): Promise<RunningHoursGridRow[]> {
    const viewport = this.runningHoursTable.locator('.ag-body-viewport').first();
    const rows = new Map<number, RunningHoursGridRow>();
    const rateColumnId = await this.runningHoursTable.locator('[role="columnheader"][col-id]')
      .filter({ hasText: /rate/i }).first().getAttribute('col-id').catch(() => null);
    const readRendered = () => this.runningHoursTable.evaluate((grid) => {
      const byIndex = new Map<number, Record<string, string>>();
      for (const row of Array.from(grid.querySelectorAll('[role="row"][row-index]'))) {
        const index = Number(row.getAttribute('row-index'));
        const cells = byIndex.get(index) ?? {};
        // Pinned columns render a row's cells in separate row elements with the same index.
        for (const cell of Array.from(row.querySelectorAll('[role="gridcell"][col-id]'))) {
          cells[cell.getAttribute('col-id') ?? ''] = (cell.textContent ?? '').replace(/\s+/g, ' ').trim();
        }
        byIndex.set(index, cells);
      }
      return [...byIndex.entries()];
    });
    const position = () => viewport.evaluate((node) => ({ top: node.scrollTop, height: node.clientHeight, total: node.scrollHeight }));

    const collect = async () => {
      for (const [rowIndex, cells] of await readRendered()) {
        rows.set(rowIndex, {
          rowIndex,
          componentName: cells.component ?? '',
          componentCode: cells.sfiCode ?? '',
          componentCategory: cells.componentCategory ?? '',
          runningHours: cells.runningHours ?? '',
          lastUpdated: cells.lastUpdated ?? '',
          inheritedRh: cells.inheritedCount ?? '',
          rateLimit: rateColumnId ? cells[rateColumnId] ?? '' : '',
        });
      }
    };

    if (!(await viewport.count())) {
      await collect();
      return [...rows.values()].sort((first, second) => first.rowIndex - second.rowIndex);
    }
    // aria-rowcount counts the header row as well as every (filtered) data row.
    const declared = Number(await this.runningHoursTable.getAttribute('aria-rowcount')) - 1;
    const expected = Number.isFinite(declared) && declared >= 0 ? declared : undefined;
    const complete = () => expected !== undefined && rows.size >= expected;
    await viewport.evaluate((node) => { node.scrollTop = 0; });
    for (let pass = 0; pass < 200; pass += 1) {
      await collect();
      const { top, height, total } = await position();
      if (complete() || top + height >= total - 1) break;
      const seen = rows.size;
      await viewport.evaluate((node) => { node.scrollTop += Math.max(node.clientHeight * 0.8, 1); });
      // Wait for rows the grid says exist below to render, rather than a fixed delay.
      await expect.poll(async () => {
        await collect();
        const now = await position();
        return rows.size > seen || complete() || now.top + now.height >= now.total - 1;
      }, { message: 'The next Running Hours rows should render while scrolling', timeout: 10_000 }).toBe(true);
    }
    await viewport.evaluate((node) => { node.scrollTop = 0; });
    return [...rows.values()].sort((first, second) => first.rowIndex - second.rowIndex);
  }

  /** Waits until the footer count has stayed unchanged for a moment and returns it. */
  public async readComponentCount(): Promise<RunningHoursCount> {
    let last = '';
    let since = Date.now();
    await expect.poll(async () => {
      const text = (await this.componentCount.first().innerText().catch(() => '')).trim();
      if (text !== last) {
        last = text;
        since = Date.now();
      }
      return Boolean(last) && Date.now() - since >= 1_500;
    }, { message: 'The Running Hours component count should finish loading', timeout: 30_000, intervals: [100, 250, 500] }).toBe(true);
    const match = COMPONENT_COUNT.exec(last)!;
    const shown = Number(match[1].replace(/,/g, ''));
    return { shown, total: match[2] ? Number(match[2].replace(/,/g, '')) : shown, text: last };
  }

  /**
   * Types a search term and waits for the filtered table to settle: the
   * displayed rows all contain the term, or the footer reports none.
   */
  public async searchComponents(term: string): Promise<RunningHoursSearchResult> {
    await expect(this.componentSearchField, 'The Running Hours component search should be available').toBeVisible();
    await this.componentSearchField.fill(term);
    await expect(this.componentSearchField).toHaveValue(term);
    const lowerTerm = term.toLowerCase();
    await expect.poll(async () => {
      const text = (await this.componentCount.first().innerText().catch(() => '')).trim();
      if (/^Showing\s+0\b/.test(text)) return true;
      const names = await this.overviewDataRows.evaluateAll((rows) =>
        rows.map((row) => row.querySelector('[role="gridcell"], [role="cell"], td')?.textContent ?? ''));
      return names.length > 0 && names.every((name) => name.toLowerCase().includes(lowerTerm));
    }, { message: `The Running Hours search for "${term}" should finish filtering`, timeout: 15_000 }).toBe(true);
    const count = await this.readComponentCount();
    return { ...count, rows: await this.readAllRows() };
  }

  /** Clears the component search and returns the settled, unfiltered count. */
  public async clearComponentSearch(): Promise<RunningHoursCount> {
    await this.componentSearchField.fill('');
    await expect(this.componentSearchField).toHaveValue('');
    await expect(this.componentCount.first(), 'The unfiltered Running Hours count should return').not.toContainText(' of ');
    return this.readComponentCount();
  }

  /** Brings one virtualized grid row into view without filtering the table. */
  private async focusOverviewRow(rowIndex: number): Promise<Locator> {
    await expect(this.componentSearchField, 'Candidate discovery should keep Search Component empty').toHaveValue('');
    const viewport = this.runningHoursTable.locator('.ag-body-viewport').first();
    const row = this.runningHoursTable.locator(`[role="row"][row-index="${rowIndex}"]`);
    if (await viewport.count()) {
      await viewport.evaluate((node) => { node.scrollTop = 0; });
      for (let attempt = 0; attempt < 200 && !(await row.first().isVisible().catch(() => false)); attempt += 1) {
        const moved = await viewport.evaluate((node) => {
          const before = node.scrollTop;
          node.scrollTop = Math.min(node.scrollTop + Math.max(node.clientHeight * 0.8, 1), node.scrollHeight);
          return node.scrollTop > before;
        });
        if (!moved) break;
        await expect.poll(() => row.count(), { timeout: 2_000, message: `Running Hours row ${rowIndex} should render while scrolling` })
          .toBeGreaterThan(0).catch(() => undefined);
      }
    }
    await expect(row.first(), `Running Hours row ${rowIndex} should be reachable in the unfiltered table`).toBeVisible();
    await row.first().scrollIntoViewIfNeeded();
    return row;
  }

  /** Opens a row's clickable Inherited RH indicator, reads it, and closes it without changing data. */
  public async inspectInheritedDetails(row: RunningHoursGridRow): Promise<RunningHoursInheritedDetails> {
    const rowParts = await this.focusOverviewRow(row.rowIndex);
    const cell = rowParts.locator('[role="gridcell"][col-id="inheritedCount"]').filter({ visible: true }).first();
    await expect(cell, `Component ${row.componentCode} should expose its Inherited RH cell`).toBeVisible();
    const indicator = (await cell.innerText()).replace(/\s+/g, ' ').trim();
    const trigger = cell.locator('button, [role="button"], a').filter({ visible: true }).first();
    await expect(trigger, `The positive Inherited RH indicator for ${row.componentCode} should be clickable`).toBeVisible();
    const childrenResponse = this.page.waitForResponse((response) => {
      const path = new URL(response.url()).pathname;
      return response.request().method() === 'GET'
        && path.includes('/technical/api/running-hours/children/')
        && path.endsWith(`/${row.componentCode}`);
    }, { timeout: 10_000 }).catch(() => undefined);
    await trigger.click();
    const response = await childrenResponse;
    const surface = this.page.locator('[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]')
      .filter({ visible: true }).last();
    await expect(surface, `Inherited information for ${row.componentCode} should open`).toBeVisible();
    const details = (await surface.innerText()).replace(/\s+/g, ' ').trim();
    const close = surface.getByRole('button', { name: /close|cancel/i }).filter({ visible: true }).first();
    if (await close.count()) await close.click();
    else await this.page.keyboard.press('Escape');
    await expect(surface, 'Inherited information should close before candidate evaluation continues').toBeHidden();
    const payload = response?.ok() ? await response.json().catch(() => undefined) as {
      children?: RunningHoursInheritedChild[];
    } | undefined : undefined;
    let cache = inheritedChildrenByPage.get(this.page);
    if (!cache) {
      cache = new Map<string, RunningHoursInheritedChild[]>();
      inheritedChildrenByPage.set(this.page, cache);
    }
    if (payload?.children) cache.set(row.componentCode, payload.children);
    return { indicator, details, children: payload?.children ?? cache.get(row.componentCode) ?? [] };
  }

  /** Opens the exact row action that exposes Set Total/Add Delta and returns its observed tooltip. */
  public async openUpdateControls(row: RunningHoursGridRow): Promise<{ tooltip: string }> {
    const rowParts = await this.focusOverviewRow(row.rowIndex);
    const action = rowParts.locator([
      'button[aria-label*="setting" i]',
      'button[title*="setting" i]',
      'button[aria-label*="running hour" i]',
      'button[title*="running hour" i]',
      'button:has(svg.lucide-settings)',
    ].join(', ')).filter({ visible: true }).first();
    await expect(action, `Component ${row.componentCode} should expose its Running Hours Settings action`).toBeVisible();
    await action.hover();
    const tooltip = (await this.page.getByRole('tooltip').filter({ visible: true }).last().innerText().catch(() => ''))
      || (await action.getAttribute('aria-label'))
      || (await action.getAttribute('title'))
      || 'Settings';
    await action.click();
    const panel = this.page.getByRole('dialog').filter({ visible: true }).last();
    await expect(panel, `The Running Hours update controls for ${row.componentCode} should open`).toBeVisible();
    return { tooltip: tooltip.replace(/\s+/g, ' ').trim() };
  }

  /**
   * Confirms that a candidate exposes the requested update mode without
   * changing data, then closes the dialog so discovery can continue safely.
   */
  public async inspectUpdateAvailability(row: RunningHoursGridRow, action: RunningHoursUpdateAction): Promise<{ available: boolean; reason: string }> {
    try {
      const { tooltip } = await this.openUpdateControls(row);
      const panel = this.page.getByRole('dialog').filter({ visible: true }).last();
      const mode = panel.getByRole('radio', { name: action, exact: true })
        .or(panel.getByRole('button', { name: action, exact: true }))
        .or(panel.getByText(action, { exact: true })).first();
      const available = await mode.isVisible().catch(() => false)
        && await mode.isEnabled().catch(() => false);
      const close = panel.getByRole('button', { name: /close|cancel/i }).filter({ visible: true }).first();
      if (await close.count()) await close.click();
      else await this.page.keyboard.press('Escape');
      await expect(panel, 'The candidate inspection dialog should close without saving').toBeHidden();
      return {
        available,
        reason: available
          ? `${action} is available through the ${tooltip} action.`
          : `${action} is not enabled in the update controls.`,
      };
    } catch (error) {
      const panel = this.page.getByRole('dialog').filter({ visible: true }).last();
      if (await panel.count()) {
        const close = panel.getByRole('button', { name: /close|cancel/i }).filter({ visible: true }).first();
        if (await close.count()) await close.click().catch(() => undefined);
        else await this.page.keyboard.press('Escape').catch(() => undefined);
      }
      return {
        available: false,
        reason: error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : String(error),
      };
    }
  }

  /** Enters a valid update and cancels it without sending a write request. */
  public async cancelPendingUpdate(
    row: RunningHoursGridRow,
    action: RunningHoursUpdateAction,
    reading: number,
    date: string,
    options: { alreadyOpen?: boolean; beforeCancel?: (state: { oldValue: string; enteredValue: string; selectedDate: string; updateMode: RunningHoursUpdateAction }) => Promise<void> } = {},
  ): Promise<{ oldValue: string; enteredValue: string; selectedDate: string; dialogClosed: boolean }> {
    if (!options.alreadyOpen) await this.openUpdateControls(row);
    const dialog = this.page.getByRole('dialog').filter({ visible: true }).last();
    const mode = dialog.getByRole('radio', { name: action, exact: true })
      .or(dialog.getByText(action, { exact: true })).first();
    await mode.click();
    const inputs = dialog.locator('input[type="number"]').filter({ visible: true });
    const oldValue = await inputs.first().inputValue().catch(() => row.runningHours);
    const readingInput = inputs.last();
    await readingInput.fill(String(reading));
    const dateInput = dialog.getByLabel(/date updated|date/i).filter({ visible: true }).first()
      .or(dialog.locator('input[type="date"]').filter({ visible: true }).first());
    await dateInput.fill(date);
    const enteredValue = await readingInput.inputValue();
    const selectedDate = await dateInput.inputValue();
    await options.beforeCancel?.({ oldValue, enteredValue, selectedDate, updateMode: action });
    await dialog.getByRole('button', { name: /^cancel$/i }).filter({ visible: true }).click();
    await expect(dialog, 'Cancel should close the Update Running Hours dialog').toBeHidden();
    return { oldValue, enteredValue, selectedDate, dialogClosed: true };
  }

  /** Opens the real Meter Replacement Confirmation dialog shown by the update form. */
  public async openMeterReplacementConfirmation(
    row: RunningHoursGridRow,
    options: { alreadyOpen?: boolean } = {},
  ): Promise<Omit<MeterReplacementConfirmationState, 'actionType' | 'reason'>> {
    if (!options.alreadyOpen) await this.openUpdateControls(row);
    const updateDialog = this.page.getByRole('dialog').filter({ visible: true }).last();
    const meterReplaced = updateDialog.getByRole('checkbox', { name: /meter replaced/i }).filter({ visible: true }).first()
      .or(updateDialog.locator('input[type="checkbox"]').filter({ visible: true }).first());
    await expect(meterReplaced, 'The Update Running Hours form should expose Meter replaced').toBeVisible();
    // The application deliberately keeps this control unchecked until the
    // separate confirmation is accepted, so check() would incorrectly require
    // an immediate checked state even though the click opened the right dialog.
    await meterReplaced.click();

    const confirmation = this.page.getByRole('dialog').filter({ hasText: /Meter Replacement Confirmation/i }).filter({ visible: true }).last();
    await expect(confirmation, 'Checking Meter replaced should open Meter Replacement Confirmation').toBeVisible();
    const text = (await confirmation.innerText()).replace(/\s+/g, ' ').trim();
    const readValue = (label: string) => {
      const match = text.match(new RegExp(`${label}:?\\s*(.*?)\\s*(?=Component(?: Code)?:|Current RH:|Action Type|$)`, 'i'));
      return match?.[1]?.trim() ?? '';
    };
    return {
      title: 'Meter Replacement Confirmation',
      instruction: text.match(/Please provide details about the meter replacement\.?/i)?.[0] ?? '',
      componentName: readValue('Component'),
      componentCode: readValue('Component Code'),
      currentRh: readValue('Current RH'),
      confirmationText: text,
    };
  }

  /** Completes the confirmation fields without saving Running Hours and returns to the update form. */
  public async confirmMeterReplacementDetails(
    reason: string,
  ): Promise<MeterReplacementConfirmationState & PreparedMeterReplacementState> {
    const confirmation = this.page.getByRole('dialog').filter({ hasText: /Meter Replacement Confirmation/i }).filter({ visible: true }).last();
    await expect(confirmation, 'Meter Replacement Confirmation should remain open').toBeVisible();
    const initialText = (await confirmation.innerText()).replace(/\s+/g, ' ').trim();
    const actionType = confirmation.getByLabel(/action type/i).filter({ visible: true }).first()
      .or(confirmation.getByRole('combobox').filter({ visible: true }).first());
    await actionType.click();
    await this.page.getByRole('option', { name: 'Replaced', exact: true }).filter({ visible: true }).last().click();
    const reasonField = confirmation.getByLabel(/reason|notes/i).filter({ visible: true }).first()
      .or(confirmation.getByPlaceholder(/reason for meter replacement/i).filter({ visible: true }).first());
    await reasonField.fill(reason);
    const selectedAction = await actionType.inputValue().catch(async () => (await actionType.textContent())?.trim() ?? 'Replaced');
    const enteredReason = await reasonField.inputValue();
    await confirmation.getByRole('button', { name: /^confirm meter replacement$/i }).click();
    await expect(confirmation, 'Confirm Meter Replacement should return to Update Running Hours').toBeHidden();

    const updateDialog = this.page.getByRole('dialog').filter({ hasText: /Update Running Hours/i }).filter({ visible: true }).last();
    await expect(updateDialog, 'The prepared meter replacement should be shown in Update Running Hours').toBeVisible();
    const oldMeterFinalInput = updateDialog.getByLabel(/old meter final/i).filter({ visible: true }).first()
      .or(updateDialog.locator('input[type="number"]').filter({ visible: true }).nth(2));
    const newMeterStartInput = updateDialog.getByLabel(/new meter start/i).filter({ visible: true }).first()
      .or(updateDialog.locator('input[type="number"]').filter({ visible: true }).last());
    const meterReplaced = updateDialog.getByRole('checkbox', { name: /meter replaced/i }).filter({ visible: true }).first()
      .or(updateDialog.locator('input[type="checkbox"]').filter({ visible: true }).first());
    const save = updateDialog.getByRole('button', { name: /^save$/i }).filter({ visible: true }).first();
    const readSummary = (label: string) => {
      const match = initialText.match(new RegExp(`${label}:?\\s*(.*?)\\s*(?=Component(?: Code)?:|Current RH:|Action Type|$)`, 'i'));
      return match?.[1]?.trim() ?? '';
    };
    return {
      title: 'Meter Replacement Confirmation',
      instruction: initialText.match(/Please provide details about the meter replacement\.?/i)?.[0] ?? '',
      componentName: readSummary('Component'),
      componentCode: readSummary('Component Code'),
      currentRh: readSummary('Current RH'),
      actionType: selectedAction || 'Replaced',
      reason: enteredReason,
      confirmationText: initialText,
      oldMeterFinal: await oldMeterFinalInput.inputValue().catch(() => ''),
      newMeterStart: await newMeterStartInput.inputValue().catch(() => ''),
      meterReplaced: await meterReplaced.isChecked(),
      saveEnabled: await save.isEnabled(),
    };
  }

  /** Cancels the prepared replacement from Update Running Hours; Save is never clicked. */
  public async cancelPreparedMeterReplacement(): Promise<{ dialogClosed: boolean; notification: string }> {
    const updateDialog = this.page.getByRole('dialog').filter({ hasText: /Update Running Hours/i }).filter({ visible: true }).last();
    await expect(updateDialog, 'The prepared meter replacement should remain open until Cancel').toBeVisible();
    await updateDialog.getByRole('button', { name: /^cancel$/i }).click();
    await expect(updateDialog, 'Cancel should close the prepared meter replacement').toBeHidden();
    const notification = await readAppNotification(this.page).catch(() => '');
    return { dialogClosed: true, notification };
  }

  /** Exercises the visible update form without assuming one generic validation message. */
  public async attemptRejectedUpdate(
    row: RunningHoursGridRow,
    action: RunningHoursUpdateAction,
    value: string | undefined,
    date?: string,
    options: {
      alreadyOpen?: boolean;
      expectedApplicationValidation?: string | RegExp;
      beforeSave?: (state: Pick<RunningHoursRejectedAttempt,
        'oldValue' | 'attemptedValue' | 'actualFieldValue' | 'selectedDate' | 'updateMode' | 'meterReplaced' | 'saveEnabled'>) => Promise<void>;
    } = {},
  ): Promise<RunningHoursRejectedAttempt> {
    if (!options.alreadyOpen) await this.openUpdateControls(row);
    const panel = this.page.getByRole('dialog').filter({ visible: true }).last();
    const mode = panel.getByRole('radio', { name: action, exact: true })
      .or(panel.getByRole('button', { name: action, exact: true }))
      .or(panel.getByText(action, { exact: true })).first();
    await mode.click();
    const numericInputs = panel.locator('input[type="number"]').filter({ visible: true });
    const oldValue = await panel.locator('input').filter({ visible: true }).first().inputValue().catch(() => '')
      || row.runningHours;
    const reading = numericInputs.last();
    let automationError = '';
    try {
      await reading.fill(value ?? '');
      await reading.blur();
    } catch (error) {
      automationError = error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : String(error);
    }
    const dateInput = panel.getByLabel(/date updated|date/i).filter({ visible: true }).first()
      .or(panel.locator('input[type="date"]').filter({ visible: true }).first());
    if (date !== undefined) {
      await dateInput.fill(date);
    }
    const actualFieldValue = await reading.inputValue().catch(() => '');
    const selectedDate = await dateInput.inputValue().catch(() => '');
    const meterReplacedControl = panel.getByRole('checkbox', { name: /meter replaced/i }).filter({ visible: true }).first()
      .or(panel.locator('input[type="checkbox"]').filter({ visible: true }).first());
    const meterReplaced = await meterReplacedControl.isChecked().catch(() => false);
    const submit = panel.getByRole('button', { name: /^(?:save|update)$/i }).filter({ visible: true }).first();
    const saveEnabled = await submit.isEnabled().catch(() => false);
    await options.beforeSave?.({
      oldValue,
      attemptedValue: value ?? '',
      actualFieldValue,
      selectedDate,
      updateMode: action,
      meterReplaced,
      saveEnabled,
    });
    let saveClicked = false;
    let feedback = '';
    if (saveEnabled) {
      saveClicked = true;
      await submit.click();
      if (options.expectedApplicationValidation) {
        const exactMessage = this.page.getByText(options.expectedApplicationValidation,
          typeof options.expectedApplicationValidation === 'string' ? { exact: true } : undefined)
          .filter({ visible: true }).last();
        await exactMessage.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
        feedback = await exactMessage.innerText().catch(() => '');
      }
      if (!feedback) feedback = await readAppNotification(this.page).catch(() => '');
      feedback = feedback.replace(/^\s*(?:Notification\s*)?(?:Error\s*)?/i, '').trim();
    }
    // Read only application-owned feedback. Interaction exceptions are retained
    // separately and must never be presented as PMS validation.
    const inlineValidation = await panel.locator([
      '[role="alert"]',
      '[aria-live="assertive"]',
      '[aria-live="polite"]',
      '.text-red-500',
      '.text-red-600',
      '[class*="error" i]',
      '[class*="invalid" i]',
    ].join(', ')).filter({ visible: true }).allInnerTexts()
      .then((items) => items.map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | '))
      .catch(() => '');
    const fieldValidation = await reading.evaluate((element) => (element as HTMLInputElement).validationMessage)
      .catch(() => '');
    const applicationValidation = [fieldValidation, inlineValidation, feedback]
      .map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ');
    // Deliberately leave the dialog open so the caller captures the form and
    // its validation before refresh/navigation destroys that evidence.
    return {
      oldValue,
      attemptedValue: value ?? '',
      actualFieldValue,
      selectedDate,
      updateMode: action,
      meterReplaced,
      saveEnabled,
      saveClicked,
      applicationValidation,
      automationError,
      feedback,
    };
  }

  /** Reads and changes the Running Hours validation control shown on this screen. */
  public async rhValidationState(): Promise<'ON' | 'OFF'> {
    const label = this.page.getByText('RH Validation', { exact: true }).filter({ visible: true }).first();
    await expect(label, 'The RH Validation control should be visible').toBeVisible();
    const status = label.locator('xpath=following::*[normalize-space()="ON" or normalize-space()="OFF"][1]');
    await expect(status, 'The RH Validation status should be visible beside its label').toBeVisible();
    const text = (await status.innerText()).replace(/\s+/g, ' ');
    return /\bON\b/i.test(text) ? 'ON' : 'OFF';
  }

  public async setRhValidationState(state: 'ON' | 'OFF'): Promise<void> {
    if (await this.rhValidationState() === state) return;
    const label = this.page.getByText('RH Validation', { exact: true }).filter({ visible: true }).first();
    const status = label.locator('xpath=following::*[normalize-space()="ON" or normalize-space()="OFF"][1]');
    const interactive = status.locator('xpath=ancestor-or-self::*[self::button or @role="button"][1]');
    if (await interactive.count()) await interactive.click();
    else await status.click();
    await expect.poll(() => this.rhValidationState(), { message: `RH Validation should become ${state}` }).toBe(state);
  }

  /** Reads the actual per-vessel RH Validation switch on PMS Admin > Master Data. */
  public async adminRhValidationState(vessel: string): Promise<'ON' | 'OFF'> {
    const vesselName = this.page.getByText(vessel, { exact: true }).filter({ visible: true }).first();
    await expect(vesselName, `PMS Admin should display the settings card for ${vessel}`).toBeVisible();
    const card = vesselName.locator('xpath=ancestor::div[.//*[normalize-space()="RH Validation"] and (.//*[@role="switch"] or .//input[@type="checkbox"])][1]');
    await expect(card, `${vessel} should expose its RH Validation setting`).toBeVisible();
    const label = card.getByText('RH Validation', { exact: true }).last();
    const control = label.locator('xpath=following::*[@role="switch" or self::input[@type="checkbox"]][1]');
    await expect(control, `${vessel} RH Validation should use the visible Admin switch`).toBeVisible();
    if (await control.getAttribute('role') === 'switch') {
      return await control.getAttribute('aria-checked') === 'true' ? 'ON' : 'OFF';
    }
    return await control.isChecked() ? 'ON' : 'OFF';
  }

  /** Changes and verifies the actual per-vessel RH Validation switch on PMS Admin. */
  public async setAdminRhValidationState(vessel: string, state: 'ON' | 'OFF'): Promise<void> {
    if (await this.adminRhValidationState(vessel) === state) return;
    const vesselName = this.page.getByText(vessel, { exact: true }).filter({ visible: true }).first();
    const card = vesselName.locator('xpath=ancestor::div[.//*[normalize-space()="RH Validation"] and (.//*[@role="switch"] or .//input[@type="checkbox"])][1]');
    const label = card.getByText('RH Validation', { exact: true }).last();
    const control = label.locator('xpath=following::*[@role="switch" or self::input[@type="checkbox"]][1]');
    await control.click();
    await expect.poll(() => this.adminRhValidationState(vessel), {
      message: `${vessel} RH Validation should become ${state} in PMS Admin`,
    }).toBe(state);
  }

  /** Uses the visible Running Hours update dialog; labels are resolved from the application at runtime. */
  public async submitUpdate(
    action: RunningHoursUpdateAction,
    reading: number,
    date: string,
    options: {
      beforeSave?: (state: { oldValue: string; enteredValue: string; selectedDate: string; updateMode: RunningHoursUpdateAction }) => Promise<void>;
      responseTimeoutMs?: number;
      comment?: string;
    } = {},
  ): Promise<RunningHoursUpdateResult> {
    const panel = this.page.getByRole('dialog').filter({ visible: true }).last();
    await expect(panel).toBeVisible();
    const mode = panel.getByRole('radio', { name: action, exact: true })
      .or(panel.getByRole('button', { name: action, exact: true }))
      .or(panel.getByText(action, { exact: true }));
    await expect(mode.first(), `${action} should be offered by the Running Hours update controls`).toBeVisible();
    await mode.first().click();

    const readingInput = panel.locator('input[type="number"]').filter({ visible: true }).last();
    await expect(readingInput, 'The Running Hours reading input should be visible').toBeVisible();
    await readingInput.fill(String(reading));
    const dateInput = panel.getByLabel(/date/i).filter({ visible: true }).first()
      .or(panel.locator('input[type="date"]').filter({ visible: true }).first());
    await expect(dateInput, 'The Running Hours update date input should be visible').toBeVisible();
    await dateInput.fill(date);
    if (options.comment !== undefined) {
      const comment = panel.getByLabel(/comments?/i).filter({ visible: true }).first()
        .or(panel.getByPlaceholder(/comments?|reason/i).filter({ visible: true }).first())
        .or(panel.locator('textarea').filter({ visible: true }).first());
      if (await comment.count()) await comment.fill(options.comment);
    }

    await options.beforeSave?.({
      oldValue: await panel.locator('input').filter({ visible: true }).first().inputValue().catch(() => ''),
      enteredValue: await readingInput.inputValue(),
      selectedDate: await dateInput.inputValue(),
      updateMode: action,
    });

    const submit = panel.getByRole('button', { name: /^(?:save|update)$/i }).filter({ visible: true }).first();
    await expect(submit, 'The Running Hours Save or Update button should be visible').toBeEnabled();
    const response = this.page.waitForResponse((candidate) => /\/technical\/api\/running-hours\/cascade(?:\?|$)/i.test(candidate.url())
      && ['POST', 'PUT', 'PATCH'].includes(candidate.request().method()), { timeout: options.responseTimeoutMs ?? 10_000 }).catch(() => undefined);
    await submit.click();
    const [networkResponse, feedback] = await Promise.all([response, readAppNotification(this.page)]);
    const dialogClosed = await panel.isHidden().catch(() => false);
    expect(runningHoursSaveAccepted({ responseStatus: networkResponse?.status(), feedback, dialogClosed }),
      'The application should accept the Running Hours update').toBe(true);
    await expect(panel, 'The Running Hours update controls should close after a successful update').toBeHidden();
    const observedFeedback = feedback
      || (networkResponse ? `Running Hours update returned HTTP ${networkResponse.status()}.` : '')
      || 'The Update Running Hours dialog closed; no transient notification or matching backend response was captured.';
    return {
      tooltip: '',
      feedback: observedFeedback,
      saveEnabled: true,
      saveClicked: true,
      dialogClosed: true,
      responseStatus: networkResponse?.status(),
      requestCompleted: Boolean(networkResponse),
    };
  }

  /** Opens the recorded Bulk Update RH workflow and returns its visible dialog. */
  public async openBulkUpdateControls(): Promise<Locator> {
    const button = this.page.getByRole('button', { name: /bulk update rh/i }).filter({ visible: true }).first();
    await expect(button, 'Bulk Update RH should be available on Running Hours Overview').toBeVisible();
    await button.click();
    const dialog = this.page.getByRole('dialog').filter({ hasText: 'Bulk Update Running Hours' }).filter({ visible: true }).last();
    await expect(dialog, 'The Bulk Update Running Hours dialog should open').toBeVisible();
    return dialog;
  }

  /** Locates one exact component/old-value row in the Bulk Update dialog. */
  public bulkUpdateRow(dialog: Locator, row: RunningHoursGridRow): Locator {
    const code = dialog.getByText(row.componentCode, { exact: true }).filter({ visible: true }).first();
    return code.locator('xpath=ancestor::*[.//input[@type="number"] and .//*[normalize-space()="' + row.runningHours + '"]][1]');
  }

  /** Sets the shared mode/date used by every entered Bulk Update row. */
  public async configureBulkUpdate(dialog: Locator, date: string, action: RunningHoursUpdateAction = 'Set Total'): Promise<{ date: string; mode: string }> {
    const mode = dialog.getByRole('radio', { name: action, exact: true })
      .or(dialog.getByText(action, { exact: true })).first();
    await expect(mode, `Bulk Update should offer ${action} mode`).toBeVisible();
    await mode.click();
    const dateInput = dialog.getByLabel(/date updated|date/i).filter({ visible: true }).first()
      .or(dialog.locator('input[type="date"]').filter({ visible: true }).first());
    await dateInput.fill(date);
    return { date: await dateInput.inputValue(), mode: action };
  }

  /** Enters one Bulk Update value and returns the row's observed validation state. */
  public async fillBulkUpdateValue(dialog: Locator, row: RunningHoursGridRow, value: string): Promise<{
    value: string;
    status: string;
    validation: string;
    meterReplaced: boolean;
  }> {
    const bulkRow = this.bulkUpdateRow(dialog, row);
    await expect(bulkRow, `Bulk Update should list ${row.componentName} (${row.componentCode}) at ${row.runningHours}`).toBeVisible();
    const input = bulkRow.locator('input[type="number"]').filter({ visible: true }).first();
    await input.fill(value);
    await input.blur();
    const validation = await bulkRow.locator('[role="alert"], .text-red-500, .text-red-600, [class*="error" i]')
      .filter({ visible: true }).allInnerTexts()
      .then((items) => items.map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | '));
    const status = (await bulkRow.innerText()).replace(/\s+/g, ' ').trim();
    const meter = bulkRow.getByRole('checkbox').filter({ visible: true }).first()
      .or(bulkRow.locator('input[type="checkbox"]').filter({ visible: true }).first());
    return {
      value: await input.inputValue(),
      status,
      validation,
      meterReplaced: await meter.isChecked().catch(() => false),
    };
  }

  public async clearBulkUpdateValue(dialog: Locator, row: RunningHoursGridRow): Promise<void> {
    const input = this.bulkUpdateRow(dialog, row).locator('input[type="number"]').filter({ visible: true }).first();
    await input.fill('');
    await input.blur();
    await expect(input).toHaveValue('');
  }

  public async bulkUpdateSaveEnabled(dialog: Locator): Promise<boolean> {
    const save = dialog.getByRole('button', { name: /^save$/i }).filter({ visible: true }).first();
    return save.isEnabled();
  }

  /** Clicks Bulk Save once and observes the real UI/network outcome for a bounded diagnostic window. */
  public async saveBulkUpdate(dialog: Locator, observationWindowMs = 120_000): Promise<BulkUpdateDiagnostic> {
    const save = dialog.getByRole('button', { name: /^save$/i }).filter({ visible: true }).first();
    await expect(save, 'Bulk Update Save should be enabled after invalid rows are cleared').toBeEnabled();
    const requests = new Map<object, BulkUpdateDiagnostic['requests'][number]>();
    const consoleErrors: string[] = [];
    const relevant = (url: string) => /\/technical\/api\/running-hours\//i.test(url);
    const onRequest = (request: import('@playwright/test').Request) => {
      if (relevant(request.url()) && ['POST', 'PUT', 'PATCH'].includes(request.method())) {
        requests.set(request, { method: request.method(), url: request.url(), state: 'pending' });
      }
    };
    const onResponse = async (response: import('@playwright/test').Response) => {
      const request = response.request();
      const record = requests.get(request);
      if (!record) return;
      record.status = response.status();
      record.state = 'completed';
      record.body = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 2_000);
    };
    const onRequestFailed = (request: import('@playwright/test').Request) => {
      const record = requests.get(request);
      if (!record) return;
      record.state = 'failed';
      record.failure = request.failure()?.errorText || 'The browser reported a request failure without a reason.';
    };
    const onConsole = (message: import('@playwright/test').ConsoleMessage) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    };
    this.page.on('request', onRequest);
    this.page.on('response', onResponse);
    this.page.on('requestfailed', onRequestFailed);
    this.page.on('console', onConsole);
    const submittedAt = new Date().toISOString();
    const started = Date.now();
    let savingStateObserved = false;
    let outcome: BulkUpdateDiagnostic['outcome'] = 'unconfirmed';
    const notificationLocator = this.page.locator('[role="alert"], [data-sonner-toast], [class*="toast" i]').filter({ visible: true });
    const validationLocator = dialog.locator('[role="alert"], [aria-live="assertive"], .text-red-500, .text-red-600, [class*="error" i]').filter({ visible: true });
    await save.click();
    try {
      while (Date.now() - started < observationWindowMs) {
        const dialogVisible = await dialog.isVisible().catch(() => false);
        const buttonText = dialogVisible
          ? (await dialog.locator('button').filter({ hasText: /^(?:Save|Saving(?:\.\.\.)?)$/i }).last().innerText().catch(() => '')).trim()
          : '';
        savingStateObserved ||= /^saving/i.test(buttonText);
        const notificationText = [...new Set((await notificationLocator.allInnerTexts().catch(() => []))
          .map((text) => text.replace(/\s+/g, ' ').trim()).filter(Boolean))];
        const validationText = dialogVisible ? [...new Set((await validationLocator.allInnerTexts().catch(() => []))
          .map((text) => text.replace(/\s+/g, ' ').trim()).filter((text) => Boolean(text) && text !== '*'))] : [];
        const records = [...requests.values()];
        if (records.some((record) => record.state === 'failed')) { outcome = 'network-error'; break; }
        if (records.some((record) => (record.status ?? 0) >= 400)) { outcome = 'backend-error'; break; }
        if (notificationText.some((text) => /error|failed|cannot|invalid/i.test(text)) || validationText.length) { outcome = 'application-error'; break; }
        if (!dialogVisible || notificationText.some((text) => /bulk update completed successfully|success/i.test(text))) { outcome = 'success'; break; }
        await this.page.waitForTimeout(250);
      }
      if (outcome === 'unconfirmed') {
        const buttonText = (await dialog.locator('button').filter({ hasText: /^(?:Save|Saving(?:\.\.\.)?)$/i }).last().innerText().catch(() => '')).trim();
        outcome = /^saving/i.test(buttonText) ? 'stalled' : 'unconfirmed';
      }
      const dialogVisible = await dialog.isVisible().catch(() => false);
      const saveButton = dialog.locator('button').filter({ hasText: /^(?:Save|Saving(?:\.\.\.)?)$/i }).last();
      return {
        outcome,
        submittedAt,
        observationWindowMs,
        elapsedMs: Date.now() - started,
        savingStateObserved,
        saveButtonText: dialogVisible ? (await saveButton.innerText().catch(() => '')).trim() : '<dialog closed>',
        saveButtonEnabled: dialogVisible ? await saveButton.isEnabled().catch(() => false) : false,
        dialogVisible,
        notifications: [...new Set((await notificationLocator.allInnerTexts().catch(() => [])).map((text) => text.replace(/\s+/g, ' ').trim()).filter(Boolean))],
        validations: dialogVisible ? [...new Set((await validationLocator.allInnerTexts().catch(() => [])).map((text) => text.replace(/\s+/g, ' ').trim()).filter((text) => Boolean(text) && text !== '*'))] : [],
        requests: [...requests.values()],
        consoleErrors: [...new Set(consoleErrors)],
      };
    } finally {
      this.page.off('request', onRequest);
      this.page.off('response', onResponse);
      this.page.off('requestfailed', onRequestFailed);
      this.page.off('console', onConsole);
    }
  }

  /** Refreshes Running Hours and restores the same authorized vessel and settled table. */
  public async refreshAndRestoreVessel(vessel: string): Promise<void> {
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    await this.waitForScreen();
    if (await this.selectedVesselName() !== vessel) await this.selectVesselAndWaitForData(vessel);
    const count = await this.readComponentCount();
    if (count.shown > 0) {
      await expect(this.overviewDataRows.first(), 'Running Hours rows should render after refresh').toBeVisible();
    }
  }

  /** Reads the visible successful-update history for one component and returns to Overview. */
  public async successfulUpdateHistorySignature(componentCode: string): Promise<string> {
    const history = this.page.getByRole('button', { name: 'History', exact: true })
      .or(this.page.getByRole('tab', { name: 'History', exact: true })).first();
    await expect(history, 'Running Hours History should be available').toBeVisible();
    await history.click();
    const search = this.page.getByPlaceholder(/search component/i).filter({ visible: true }).first();
    if (await search.count()) {
      await search.fill(componentCode);
      await expect(search).toHaveValue(componentCode);
    }
    const grid = this.page.getByRole('grid').filter({ visible: true }).first();
    await expect(grid, 'Running Hours History should finish loading').toBeVisible();
    const signature = (await grid.innerText()).replace(/\s+/g, ' ').trim();
    const overview = this.page.getByRole('button', { name: 'Overview', exact: true })
      .or(this.page.getByRole('tab', { name: 'Overview', exact: true })).first();
    await overview.click();
    await expect(this.runningHoursTable).toBeVisible();
    if (await this.componentSearchField.inputValue().catch(() => '') !== '') await this.clearComponentSearch();
    return signature;
  }

  /** Opens the component list demonstrated under the Running Hours History tab. */
  public async openHistoryOverview(searchTerm?: string): Promise<void> {
    const history = this.page.getByRole('button', { name: 'History', exact: true })
      .or(this.page.getByRole('tab', { name: 'History', exact: true })).first();
    await history.click();
    const search = this.page.getByPlaceholder(/search component/i).filter({ visible: true }).first();
    await expect(search, 'History should expose Search Component').toBeVisible();
    if (searchTerm !== undefined) {
      await search.fill(searchTerm);
      await expect(search).toHaveValue(searchTerm);
    }
    await expect(this.page.getByRole('grid').filter({ visible: true }).first(), 'History component list should load').toBeVisible();
  }

  /** Opens View History for an exact component code from the filtered History component list. */
  public async openComponentHistory(componentCode: string): Promise<void> {
    await this.openHistoryOverview(componentCode);
    const grid = this.page.getByRole('grid').filter({ visible: true }).first();
    const code = grid.getByText(componentCode, { exact: true }).filter({ visible: true }).first();
    await expect(code, `History should list component ${componentCode}`).toBeVisible();
    const row = code.locator('xpath=ancestor::*[@role="row"][1]');
    await row.getByRole('button', { name: /view history/i }).click();
    await expect(this.page.getByRole('button', { name: /export csv/i }).filter({ visible: true }).first(),
      `History detail for ${componentCode} should expose Export CSV`).toBeVisible();
  }

  /** Returns the component-history heading and the actual visible Period control text. */
  public async componentHistoryFilterState(): Promise<{ component: string; period: string; search: string }> {
    const back = this.page.getByRole('button', { name: /^back$/i }).filter({ visible: true }).first();
    await expect(back, 'Component History detail should expose Back').toBeVisible();
    const heading = back.locator('xpath=following::*[self::h1 or self::h2 or self::h3 or self::div][1]');
    const period = this.page.getByPlaceholder(/period/i).filter({ visible: true }).first()
      .or(this.page.getByText(/^Period$/).filter({ visible: true }).first());
    const search = this.page.getByPlaceholder(/search history/i).filter({ visible: true }).first();
    return {
      component: (await heading.innerText().catch(() => '')).replace(/\s+/g, ' ').trim(),
      period: (await period.inputValue().catch(async () => (await period.innerText().catch(() => '')))).trim(),
      search: await search.inputValue().catch(() => ''),
    };
  }

  /** Reads every component History page using the recorded grid and pagination controls. */
  public async readAllComponentHistoryPages(verifyAllPages = true): Promise<{ records: RunningHoursHistoryRecord[]; pages: number; totalText: string }> {
    const grid = this.page.getByRole('grid').filter({ visible: true }).first();
    await expect(grid, 'Component History grid should be visible').toBeVisible();
    const dataRows = grid.locator('[role="row"]:has([role="gridcell"], [role="cell"])');
    const total = this.page.getByText(/Showing\s+\d+\s*-\s*\d+\s+of\s+\d+\s+records/i).filter({ visible: true }).first();
    let settledSignature = '';
    let settledSince = Date.now();
    await expect.poll(async () => {
      const signature = `${await dataRows.count()}|${await total.innerText().catch(() => '')}`;
      if (signature !== settledSignature) {
        settledSignature = signature;
        settledSince = Date.now();
      }
      return Date.now() - settledSince >= 1_000;
    }, { message: 'Component History rows and total should finish loading', timeout: 30_000, intervals: [100, 250, 500] }).toBe(true);
    const records: RunningHoursHistoryRecord[] = [];
    let pages = 0;
    let totalText = '';
    for (let guard = 0; guard < 200; guard += 1) {
      pages += 1;
      const pageRows = await grid.evaluate((node) => {
        const headers = Array.from(node.querySelectorAll('[role="columnheader"]')).map((header) =>
          ((header.textContent ?? '').replace(/\s+/g, ' ').trim()));
        return Array.from(node.querySelectorAll('[role="row"]')).slice(1).map((row) => {
          const cells = Array.from(row.querySelectorAll('[role="gridcell"], [role="cell"]'))
            .map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim());
          return Object.fromEntries(cells.map((value, index) => [headers[index] || `Column ${index + 1}`, value]));
        }).filter((row) => Object.values(row).some(Boolean));
      });
      records.push(...pageRows);
      totalText = (await this.page.getByText(/Showing\s+\d+\s*-\s*\d+\s+of\s+\d+\s+records/i)
        .filter({ visible: true }).first().innerText().catch(() => totalText)).trim();
      if (!verifyAllPages) break;
      const next = this.page.getByRole('button', { name: /next/i }).filter({ visible: true }).last()
        .or(this.page.locator('button').filter({ hasText: /^>$/ }).filter({ visible: true }).last());
      if (!(await next.count()) || await next.isDisabled().catch(() => true)) break;
      const before = JSON.stringify(pageRows);
      await next.click();
      await expect.poll(async () => JSON.stringify(await grid.locator('[role="row"]').allInnerTexts()), {
        message: 'The next History page should load', timeout: 15_000,
      }).not.toBe(before);
    }
    return { records, pages, totalText };
  }

  /** Downloads the actual component-level CSV export demonstrated in History. */
  public async exportComponentHistory(timeoutMs: number): Promise<import('@playwright/test').Download> {
    const exportButton = this.page.getByRole('button', { name: /export csv/i }).filter({ visible: true }).first();
    await expect(exportButton, 'Component History should expose Export CSV').toBeVisible();
    const download = this.page.waitForEvent('download', { timeout: timeoutMs });
    await exportButton.click();
    return download;
  }

  public async backFromComponentHistory(): Promise<void> {
    await this.page.getByRole('button', { name: /^back$/i }).filter({ visible: true }).first().click();
    await expect(this.page.getByPlaceholder(/search component/i).filter({ visible: true }).first()).toBeVisible();
  }

  /**
   * Selects the vessel and waits until the Running Hours screen is ready again.
   */
  public async selectVessel(name = config.vesselName): Promise<void> {
    await expect(
      this.pageLoadedIndicator,
      'The Running Hours page should be ready before selecting a vessel',
    ).toBeVisible();

    await this.vesselDropdown.click();

    await this.page.getByRole('option', {
      name,
      exact: true,
    }).click();

    await expect(this.vesselDropdown).toHaveText(name);

    await expect(
      this.overviewTab,
      'The Running Hours Overview tab should remain available after vessel selection',
    ).toBeVisible();
  }

  /**
   * Reads every rendered Running Hours row from the UI.
   * If the grid uses an internal scroll container, the method scrolls it
   * and collects each unique component code before returning to the top.
   */
  public async readOverviewRows(
    options: { allowEmpty?: boolean } = {},
  ): Promise<RunningHoursUiRow[]> {
    // The footer is authoritative, even if the empty grid still says loading.
    // Restart the quiet period whenever the count changes or disappears.
    const componentCount = this.page.getByText(/^Showing\s+[\d,]+\s+components?$/);
    let currentCount = -1;
    let unchangedSince = Date.now();

    await expect.poll(async () => {
      if (!await componentCount.isVisible()) {
        currentCount = -1;
        unchangedSince = Date.now();
        return false;
      }
      const text = await componentCount.innerText();
       const match = /^Showing\s+([\d,]+)\s+components?$/.exec(text.trim());
      const count = match ? Number(match[1].replace(/,/g, '')) : -1;
      if (count !== currentCount || count < 0) {
        currentCount = count;
        unchangedSince = Date.now();
      }
      return currentCount >= 0 && Date.now() - unchangedSince >= 2_000;
    }, {
      message: 'The Running Hours footer component count should settle',
      timeout: 15_000,
      intervals: [100, 250, 500],
    }).toBe(true);

    if (currentCount === 0) {
      expect(
        options.allowEmpty,
        'Running Hours is empty; pass allowEmpty only when the scenario validates whether zero rows are expected.',
      ).toBe(true);
      return [];
    }

    await expect(this.runningHoursTable).toBeVisible();
    await expect(this.overviewDataRows.first(),
      'A non-zero component count should render Running Hours rows',
    ).toBeVisible();

    const rowsByCode = new Map<string, RunningHoursUiRow>();

    const readSnapshot = async () =>
      this.page.evaluate(() => {
        const grid = document.querySelector<HTMLElement>(
          '[role="grid"]',
        );

        if (!grid) {
          return {
            rows: [] as RunningHoursUiRow[],
            scrollTop: 0,
            clientHeight: 0,
            scrollHeight: 0,
            hasScroller: false,
          };
        }

        const headerCells = Array.from(
          grid.querySelectorAll<HTMLElement>(
            '[role="columnheader"]',
          ),
        );

        const headers = headerCells.map((cell) =>
          cell.innerText.trim().toLowerCase(),
        );

        const indexOf = (
          pattern: RegExp,
          startAt = 0,
        ): number =>
          headers.findIndex(
            (header, index) =>
              index >= startAt && pattern.test(header),
          );

        const nameIndex = indexOf(/component\s*name/);

        const componentPlaceholderIndexes = headers
          .map((header, index) => ({ header, index }))
          .filter(
            ({ header, index }) =>
              index > nameIndex &&
              /component\s*(?:code|category|c\s*\.{2,}|\.{2,}|c…)/.test(
                header,
              ),
          )
          .map(({ index }) => index);

        const codeIndex =
          indexOf(/component\s*code/, nameIndex + 1) >= 0
            ? indexOf(/component\s*code/, nameIndex + 1)
            : componentPlaceholderIndexes[0];

        const categoryIndex =
          indexOf(/component\s*category/, nameIndex + 1) >= 0
            ? indexOf(/component\s*category/, nameIndex + 1)
            : componentPlaceholderIndexes.find(
                (index) => index !== codeIndex,
              );

        const runningHoursIndex = indexOf(/running\s*hours/);
        const inheritedIndex = indexOf(/inherited\s*rh/);

        const resolvedCodeIndex = codeIndex ?? 1;
        const resolvedCategoryIndex = categoryIndex ?? 2;

        const rowElements = Array.from(
          grid.querySelectorAll<HTMLElement>('[role="row"]'),
        ).filter(
          (row) =>
            !row.querySelector('[role="columnheader"]'),
        );

        const rows = rowElements
          .map((row) => {
            const cells = Array.from(
              row.querySelectorAll<HTMLElement>(
                '[role="cell"], [role="gridcell"], td',
              ),
            ).map((cell) => cell.innerText.trim());

            return {
              componentName:
                cells[nameIndex >= 0 ? nameIndex : 0] ?? '',
              componentCode:
                cells[resolvedCodeIndex] ?? '',
              componentCategory:
                cells[resolvedCategoryIndex] ?? '',
              runningHours:
                cells[
                  runningHoursIndex >= 0
                    ? runningHoursIndex
                    : 3
                ] ?? '',
              inheritedRh:
                cells[
                  inheritedIndex >= 0
                    ? inheritedIndex
                    : 6
                ] ?? '',
            };
          })
          .filter(
            (row) =>
              row.componentCode ||
              row.componentName,
          );

        // The application can render a virtualized grid. The grid itself
        // may be the scroll container, so check it before its ancestors.
        let scroller: HTMLElement | null = grid;

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

    for (let attempt = 0; attempt < 120; attempt += 1) {
      const snapshot = await readSnapshot();

      for (const row of snapshot.rows) {
        const code = row.componentCode.trim();

        if (code) {
          rowsByCode.set(code, row);
        }
      }

      if (
        !snapshot.hasScroller ||
        snapshot.scrollTop + snapshot.clientHeight >=
          snapshot.scrollHeight - 2
      ) {
        break;
      }

      const previousScrollTop = snapshot.scrollTop;

      await this.page.evaluate(() => {
        const grid = document.querySelector<HTMLElement>(
          '[role="grid"]',
        );

        if (!grid) {
          return;
        }

        let scroller: HTMLElement | null = grid;

        while (scroller && scroller !== document.body) {
          if (
            scroller.scrollHeight >
            scroller.clientHeight + 1
          ) {
            break;
          }

          scroller = scroller.parentElement;
        }

        if (
          scroller &&
          scroller !== document.body
        ) {
          scroller.scrollTop = Math.min(
            scroller.scrollTop +
              Math.max(scroller.clientHeight * 0.8, 1),
            scroller.scrollHeight,
          );
        }
      });

      await this.page.waitForTimeout(150);

      const afterScroll = await readSnapshot();

      if (
        afterScroll.scrollTop <= previousScrollTop &&
        afterScroll.rows.every(
          (row) =>
            !row.componentCode ||
            rowsByCode.has(row.componentCode.trim()),
        )
      ) {
        break;
      }
    }

    await this.page.evaluate(() => {
      const grid = document.querySelector<HTMLElement>(
        '[role="grid"]',
      );

      if (!grid) {
        return;
      }

      let scroller: HTMLElement | null = grid;

      while (scroller && scroller !== document.body) {
        if (
          scroller.scrollHeight >
          scroller.clientHeight + 1
        ) {
          break;
        }

        scroller = scroller.parentElement;
      }

      if (
        scroller &&
        scroller !== document.body
      ) {
        scroller.scrollTop = 0;
      }
    });

    return [...rowsByCode.values()];
  }}
