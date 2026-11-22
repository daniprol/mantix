/**
 * The dashboard, end to end: open it, check the plan, run a short load
 * test against the demo target and watch it finish.
 *
 * Locators use roles and visible text, the way a person finds things on
 * the page. Playwright's `expect` retries until the page matches (or the
 * timeout passes), so there are no sleeps.
 */
import { expect, test } from '@playwright/test'

test('the ready screen shows the test and its plan', async ({ page }) => {
  await page.goto('/')

  // The header names the test file that `mantix ui` was started with.
  await expect(page.getByRole('banner')).toContainText('quick')
  await expect(page.getByRole('banner')).toContainText('examples/quick.ts')

  const ready = page.getByRole('region', { name: 'Ready to run' })
  await expect(ready).toBeVisible()
  await expect(ready).toContainText('p99 < 100ms')
  await expect(ready).toContainText('errors < 1%')
  await expect(ready).toContainText('Requests go to http://localhost:4200')
  await expect(page.getByRole('button', { name: 'Start run' })).toBeEnabled()
})

test('a short run streams live data and finishes', async ({ page }) => {
  await page.goto('/')

  // quick.ts runs for 30 s; shorten it to 3 s with "Adjust load".
  await page.getByRole('button', { name: 'Adjust load' }).click()
  await page.getByLabel('Duration').fill('3s')
  // The plan preview now ends at 00:03.
  await expect(
    page.getByRole('figure', { name: 'Planned load over time' }),
  ).toContainText('00:03')

  await page.getByRole('button', { name: 'Start run' }).click()

  // Live: the header offers Stop, and the endpoint shows up in the table
  // as soon as the first Second of data arrives.
  await expect(
    page.getByRole('button', { name: 'Stop', exact: true }),
  ).toBeVisible()
  const endpoints = page.getByRole('region', { name: 'Endpoints' })
  await expect(
    endpoints.getByRole('button', { name: /\/products\/:sku/ }),
  ).toBeVisible()

  // Finished: the header says so, Start becomes "Run again", and the
  // verdict reports the full run against the two thresholds.
  const header = page.getByRole('banner')
  await expect(header.getByRole('status')).toContainText('Finished', {
    timeout: 20_000,
  })
  await expect(
    page.getByRole('button', { name: 'Run again', exact: true }),
  ).toBeVisible()
  await expect(page.getByText(/Ran the full/)).toBeVisible()
})
