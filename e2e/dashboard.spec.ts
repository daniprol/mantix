/**
 * The dashboard, end to end: open it, run short load tests against the demo
 * target, and move through every page: the run, one endpoint, the runs list,
 * and a comparison of two runs, with the browser's back button and reloads.
 *
 * Locators use roles and visible text, the way a person finds things on
 * the page. Playwright's `expect` retries until the page matches (or the
 * timeout passes), so there are no sleeps.
 */
import { type Page, expect, test } from '@playwright/test'

/** Start a 3 s run from the New run page and wait until it finishes. */
const runShortTest = async (page: Page) => {
  await page.goto('/')
  await page.getByLabel('Duration').fill('3s')
  await page.getByRole('button', { name: 'Start run' }).click()

  // Live: the run gets its own URL and the bar offers Stop.
  await expect(page).toHaveURL(/\/runs\/\w+$/)
  await expect(
    page.getByRole('button', { name: 'Stop', exact: true }),
  ).toBeVisible()

  // Finished: the bar says so and offers Run again.
  await expect(page.getByRole('banner').getByRole('status')).toContainText(
    'Finished',
    { timeout: 20_000 },
  )
  await expect(page.getByRole('button', { name: 'Run again' })).toBeVisible()
  return page.url()
}

// Every test shares one `mantix ui` server, so they run in order.
test.describe.configure({ mode: 'serial' })

test('the New run page shows the test, its checks and its plan', async ({
  page,
}) => {
  await page.goto('/')

  const banner = page.getByRole('banner')
  await expect(banner).toContainText('quick')
  await expect(banner).toContainText('examples/quick.ts')
  await expect(banner).toContainText('http://localhost:4200')

  const checks = page.getByRole('list', { name: 'Checks' })
  await expect(checks).toContainText('p99 < 100ms')
  await expect(checks).toContainText('errors < 1%')
  await expect(page.getByRole('img', { name: /Load, latency/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start run' })).toBeEnabled()
})

test('a run streams live, finishes, and opens one endpoint', async ({
  page,
}) => {
  const runUrl = await runShortTest(page)

  const endpoints = page.getByRole('region', { name: 'Endpoints' })
  await expect(endpoints).toContainText('All requests')
  await expect(endpoints).toContainText('Whole run')
  await expect(page.getByRole('table', { name: 'Checks' })).toBeVisible()

  // The endpoint's own page: same layout, with a breadcrumb back.
  await endpoints.getByRole('link', { name: /\/products\/:sku/ }).click()
  await expect(page).toHaveURL(/\/endpoints\/GET%20%2Fproducts%2F%3Asku$/)
  const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' })
  await expect(breadcrumb).toContainText('/products/:sku')
  await expect(page.getByRole('region', { name: 'Percentiles' })).toBeVisible()
  await expect(
    page.getByRole('region', { name: 'Status codes' }),
  ).toContainText('200')

  // A reload lands on the same page.
  await page.reload()
  await expect(breadcrumb).toContainText('/products/:sku')

  // The back arrow returns to the run; the browser's buttons work too.
  await page.getByRole('link', { name: 'Back' }).click()
  await expect(page).toHaveURL(runUrl)
  await page.goBack()
  await expect(breadcrumb).toBeVisible()
  await page.goForward()
  await expect(page).toHaveURL(runUrl)
})

test('two runs can be compared, down to one endpoint', async ({ page }) => {
  await runShortTest(page)

  // Compare opens this run against the previous one.
  await page
    .getByRole('banner')
    .getByRole('link', { name: 'Compare', exact: true })
    .click()
  await expect(page).toHaveURL(/\/compare\/\w+\/\w+$/)
  const endpoints = page.getByRole('region', { name: 'Endpoints' })
  await expect(endpoints).toContainText('baseline')
  await expect(endpoints).toContainText('this run')
  await expect(endpoints).toContainText('change')

  await endpoints.getByRole('link', { name: /\/products\/:sku/ }).click()
  await expect(page).toHaveURL(/\/compare\/\w+\/\w+\/endpoints\//)
  await expect(page.getByRole('region', { name: 'Percentiles' })).toContainText(
    'baseline',
  )
  await page.getByRole('link', { name: 'Back' }).click()
  await expect(page).toHaveURL(/\/compare\/\w+\/\w+$/)
})

test('the Runs page lists every run and opens one', async ({ page }) => {
  await page.goto('/runs')
  const runs = page.getByRole('region', { name: 'Runs' })
  await expect(runs.getByRole('link')).not.toHaveCount(0)
  await runs.getByRole('link').first().click()
  await expect(page).toHaveURL(/\/runs\/\w+$/)
  await expect(page.getByRole('region', { name: 'Endpoints' })).toBeVisible()
})

test('the theme switch turns the page dark and remembers it', async ({
  page,
}) => {
  await page.goto('/')
  const html = page.locator('html')
  const theme = page.getByRole('group', { name: 'Theme' })

  await theme.getByRole('button', { name: 'Dark' }).click()
  await expect(html).toHaveAttribute('data-theme', 'dark')

  // A reload keeps the choice, applied before the app starts.
  await page.reload()
  await expect(html).toHaveAttribute('data-theme', 'dark')
  await expect(theme.getByRole('button', { name: 'Dark' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  // System hands the choice back to the operating system.
  await theme.getByRole('button', { name: 'System' }).click()
  await expect(html).not.toHaveAttribute('data-theme')
})
