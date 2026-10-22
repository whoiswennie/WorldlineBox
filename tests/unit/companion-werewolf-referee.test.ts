import { expect, it } from 'vitest';
import { CompanionWerewolfReferee } from '../helpers/companion-werewolf-referee';
const roster = [
  { id: 'a', name: '林澄', role: 'wolf' as const }, { id: 'b', name: '周岚', role: 'seer' as const },
  { id: 'c', name: '宋檀', role: 'witch' as const }, { id: 'd', name: '温榆', role: 'wolf' as const },
  { id: 'e', name: '江禾', role: 'hunter' as const }, { id: 'f', name: '顾夏', role: 'villager' as const },
  { id: 'g', name: '季白', role: 'villager' as const }, { id: 'h', name: '陆遥', role: 'villager' as const },
];
it('keeps role secrets and oracle results out of public state and other participants private state', () => {
  const game = new CompanionWerewolfReferee(roster);
  expect(game.publicState().players.every(player => !('role' in player))).toBe(true);
  expect(game.privateState('a')).toMatchObject({ role: 'wolf', teammates: ['d'] });
  expect(game.privateState('f')).not.toHaveProperty('teammates');
  game.resolveNight({ wolves: { a: 'f', d: 'f' }, seer: { actorId: 'b', targetId: 'a' }, witch: { actorId: 'c', save: true } });
  expect(game.privateState('b')).toMatchObject({ visions: [{ day: 1, targetId: 'a', wolf: true }] });
  expect(game.privateState('c')).not.toHaveProperty('visions');
  expect(game.publicState()).not.toHaveProperty('roles');
  expect(game.publicState().events.every(event => !event.type.includes('vision'))).toBe(true);
});
it('rejects illegal targets and reusing potions instead of accepting the model claim', () => {
  const game = new CompanionWerewolfReferee(roster);
  expect(() => game.resolveNight({ wolves: { a: 'd', d: 'f' } })).toThrow('Illegal wolf');
  game.resolveNight({ wolves: { a: 'f', d: 'f' }, witch: { actorId: 'c', save: true } });
  game.beginVote(); game.resolveVote({ a: 'h', b: 'h', c: 'h', d: 'h', e: 'h', f: 'h', g: 'h', h: 'a' }); game.nextNight();
  expect(() => game.resolveNight({ wolves: { a: 'f', d: 'f' }, witch: { actorId: 'c', save: true } })).toThrow('already spent');
});
