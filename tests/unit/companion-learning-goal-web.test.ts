import { expect, it } from 'vitest';
import { isGoalPublicAddress, readGoalPublicWeb } from '../../src/main/companions/learning-goal-web';

it.each(['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '198.18.0.1', '192.0.2.1', '224.0.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1'])('never treats private/reserved address %s as public learning material', address => {
  expect(isGoalPublicAddress(address)).toBe(false);
});
it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('accepts globally routable address %s for a subsequently pinned request', address => {
  expect(isGoalPublicAddress(address)).toBe(true);
});
it.each(['file:///C:/private/secrets.txt', 'http://localhost/', 'http://user:password@example.com/', 'http://example.com:9222/json', 'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/'])('rejects unauthorized local/protocol material %s before any network read', async url => {
  await expect(readGoalPublicWeb(url, new AbortController().signal)).rejects.toThrow(/公开|私有|保留/u);
});
