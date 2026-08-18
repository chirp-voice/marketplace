import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test, expect } from 'vitest'

// channel/relay.ts is a byte-identical copy shared with plugins/openclaw, same convention as
// auth/pkce-login.ts (pinned from the openclaw side in plugins/openclaw/__tests__). Everything
// package-specific reaches relay.ts through RelayDeps or ./frames.ts, so the copies never need
// to differ — and this test is what makes the convention safe: a drifting copy fails CI instead
// of failing on a user's Mac. Pinned from BOTH packages because each package's CI only runs on
// its own paths; an edit landing on one side alone must still fail that side's CI.
describe('relay identity', () => {
  test('channel/relay.ts is byte-identical to the plugins/openclaw copy', () => {
    const here = import.meta.dirname
    const ours = join(here, '..', 'relay.ts')
    const theirs = join(here, '..', '..', '..', 'openclaw', 'channel', 'relay.ts')
    expect(readFileSync(ours, 'utf8')).toBe(readFileSync(theirs, 'utf8'))
  })
})
