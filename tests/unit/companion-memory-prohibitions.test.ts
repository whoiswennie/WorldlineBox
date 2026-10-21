import { expect, it, vi } from 'vitest';
import { validateCompanionMemoryProhibitions } from '../../src/main/companions/memory-model';

const config = { apiFormat: 'openai_chat' as const, baseUrl: 'https://model.invalid', model: 'global-chat', apiKey: 'fixture' };
const policy = { id: 'address-policy', tags: ['家庭住址'], persistent: true };
const reply = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });
it('uses semantic classification for changed words instead of matching the proposed Tag', async () => {
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const data = JSON.parse(request.messages[1].content);
    expect(data.purpose).toBe('vcp_memory_prohibition_check');
    expect(data.proposedDiary.tags).toEqual(['搬家']); expect(data.prohibitions[0].topics).toEqual(['家庭住址']);
    return reply({ allowed: false, matchedPolicyIds: ['address-policy'] });
  });
  expect(await validateCompanionMemoryProhibitions({ content: '我刚搬到向阳路八号三楼。', tags: ['搬家'], prohibitions: [policy] }, config, undefined, { fetchFn })).toBe(false);
  expect(fetchFn).toHaveBeenCalledOnce();
});
it('does not widen a historical one-time request into a future semantic ban or make an unnecessary model call', async () => {
  const fetchFn = vi.fn<typeof fetch>();
  expect(await validateCompanionMemoryProhibitions({ content: '我主动提供的新资料。', tags: [], prohibitions: [{ ...policy, persistent: false }] }, config, undefined, { fetchFn })).toBe(true);
  expect(fetchFn).not.toHaveBeenCalled();
});
it('keeps an unrelated proposed diary and rejects an invented policy identity', async () => {
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(reply({ allowed: true, matchedPolicyIds: [] }))
    .mockResolvedValueOnce(reply({ allowed: false, matchedPolicyIds: ['invented'] }));
  const input = { content: '这次学习了资料里的函数用法。', tags: ['学习'], prohibitions: [policy] };
  expect(await validateCompanionMemoryProhibitions(input, config, undefined, { fetchFn })).toBe(true);
  await expect(validateCompanionMemoryProhibitions(input, config, undefined, { fetchFn })).rejects.toThrow('核验未完成');
});
