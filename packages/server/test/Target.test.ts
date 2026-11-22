import { describe, expect, it } from 'vitest'

import { rate, scenario, scenariosOf } from '@mantix/core'

import { checkBaseUrl, withBaseUrl } from '../src/Target.ts'

const make = (name: string) =>
  scenario({
    name,
    baseUrl: 'http://localhost:4200',
    load: rate.constant(1, { duration: '1s' }),
    iteration: async () => {},
  })

describe('--base-url', () => {
  it('points every scenario at the new address', () => {
    const test = [make('a'), make('b')]
    const moved = withBaseUrl(test, 'https://staging.example.com')
    expect(scenariosOf(moved).map(s => s.options.baseUrl)).toEqual([
      'https://staging.example.com',
      'https://staging.example.com',
    ])
    // The original test is left as it was.
    expect(test[0]!.options.baseUrl).toBe('http://localhost:4200')
  })

  it('keeps a single scenario a single scenario', () => {
    const moved = withBaseUrl(make('a'), 'http://127.0.0.1:9000')
    expect(Array.isArray(moved)).toBe(false)
    expect(scenariosOf(moved)[0]!.options.baseUrl).toBe('http://127.0.0.1:9000')
  })

  it('changes nothing without a base URL', () => {
    const test = make('a')
    expect(withBaseUrl(test, undefined)).toBe(test)
  })

  it('accepts only full http(s) URLs', () => {
    expect(checkBaseUrl('https://staging.example.com')).toBeUndefined()
    expect(checkBaseUrl('http://localhost:4200/api')).toBeUndefined()
    expect(checkBaseUrl('staging.example.com')).toContain('full http(s) URL')
    expect(checkBaseUrl('ftp://example.com')).toContain('full http(s) URL')
  })
})
