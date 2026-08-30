import { describe, expect, it, vi } from 'vitest'
import {
  createPinnedLookup,
  isPublicIpAddress,
  resolvePublicAddresses,
} from '../src/network.ts'

describe('public HTTP destination policy', () => {
  it('accepts public unicast and blocks local, private, metadata, transition, and invalid addresses', () => {
    for (const address of ['8.8.8.8', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
      expect(isPublicIpAddress(address), address).toBe(true)
    }
    for (const address of [
      '0.0.0.0',
      '10.0.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '192.0.2.1',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      'fe80::1',
      'fc00::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '64:ff9b::808:808',
      'not-an-ip',
    ]) {
      expect(isPublicIpAddress(address), address).toBe(false)
    }
  })

  it('rejects an entire DNS answer set when any destination is non-public', async () => {
    const signal = new AbortController().signal
    await expect(resolvePublicAddresses('public.test', signal, async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '2001:4860:4860::8888', family: 6 },
    ])).resolves.toEqual([
      { address: '8.8.8.8', family: 4 },
      { address: '2001:4860:4860::8888', family: 6 },
    ])
    await expect(resolvePublicAddresses('rebinding.test', signal, async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])).rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })

  it('rejects empty, invalid-family, and mismatched resolver results', async () => {
    const signal = new AbortController().signal
    await expect(resolvePublicAddresses('empty.test', signal, async () => []))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    await expect(resolvePublicAddresses('family.test', signal, async () => [
      { address: '8.8.8.8', family: 0 },
    ])).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    await expect(resolvePublicAddresses('mismatch.test', signal, async () => [
      { address: '::1', family: 4 },
    ])).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('discovers and validates a network-specific NAT64 translation', async () => {
    const privateTranslation = vi.fn(async (hostname: string) => hostname === 'ipv4only.arpa'
      ? [{ address: '2001:4860:64:64::c000:aa', family: 6 }]
      : [{ address: '2001:4860:64:64::7f00:1', family: 6 }])
    await expect(resolvePublicAddresses(
      'nat64.test',
      new AbortController().signal,
      privateTranslation,
    )).rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))

    const publicTranslation = vi.fn(async (hostname: string) => hostname === 'ipv4only.arpa'
      ? [{ address: '2001:4860:64:64::c000:aa', family: 6 }]
      : [{ address: '2001:4860:64:64::808:808', family: 6 }])
    await expect(resolvePublicAddresses(
      'nat64.test',
      new AbortController().signal,
      publicTranslation,
    )).resolves.toEqual([{ address: '2001:4860:64:64::808:808', family: 6 }])
  })

  it('stops waiting for DNS on cancellation', async () => {
    let finish!: (value: never[]) => void
    const resolver = vi.fn(() => new Promise<never[]>((resolve) => { finish = resolve }))
    const controller = new AbortController()
    const pending = resolvePublicAddresses('slow.test', controller.signal, resolver)
    controller.abort(new Error('stop'))
    await expect(pending).rejects.toThrow('aborted during hostname resolution')
    finish([])
  })

  it('serves only retained addresses through the connector lookup', async () => {
    const lookup = createPinnedLookup([
      { address: '8.8.8.8', family: 4 },
      { address: '2001:4860:4860::8888', family: 6 },
    ])
    const call = (options: Parameters<typeof lookup>[1]) => new Promise<unknown>((resolve) => {
      lookup('fixed.test', options, (error, address, family) => {
        resolve({ error, address, family })
      })
    })
    await expect(call({ family: 4 })).resolves.toMatchObject({
      error: null,
      address: '8.8.8.8',
      family: 4,
    })
    await expect(call({ family: 7 })).resolves.toMatchObject({
      error: { code: 'ENOTFOUND' },
      address: '',
      family: 7,
    })
  })
})
