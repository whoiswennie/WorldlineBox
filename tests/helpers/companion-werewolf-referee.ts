/** Deterministic test referee. Models decide; this object only applies published rules.
 * Hidden state is never passed as a shared model prompt. This is an acceptance
 * fixture for general topics, not a second production world or a scripted player. */
export type WerewolfRole = 'wolf' | 'seer' | 'witch' | 'hunter' | 'villager';
export interface WerewolfPlayer { id: string; name: string; role: WerewolfRole; alive: boolean }
export interface WerewolfEvent { id: string; day: number; type: string; actorId?: string; targetId?: string; text: string }
export interface WerewolfNight { wolves: Record<string, string>; seer?: { actorId: string; targetId: string }; witch?: { actorId: string; save: boolean; poisonId?: string } }

export class CompanionWerewolfReferee {
  readonly players: WerewolfPlayer[];
  readonly events: WerewolfEvent[] = [];
  private readonly visions = new Map<string, Array<{ day: number; targetId: string; wolf: boolean }>>();
  private healing = true;
  private poison = true;
  private hunterShot = false;
  day = 1;
  phase: 'night' | 'day' | 'vote' | 'finished' = 'night';
  winner?: 'village' | 'wolves';
  constructor(players: Array<Pick<WerewolfPlayer, 'id' | 'name' | 'role'>>) {
    if (players.length < 6 || new Set(players.map(player => player.id)).size !== players.length) throw new Error('Invalid werewolf roster.');
    this.players = players.map(player => ({ ...player, alive: true }));
    this.record('start', '对局开始。死亡身份不公开；狼人达到人数平衡获胜，所有狼人死亡则好人获胜。');
  }
  private record(type: string, text: string, actorId?: string, targetId?: string) {
    const event = { id: 'game_event_' + (this.events.length + 1), day: this.day, type, text, actorId, targetId }; this.events.push(event); return event;
  }
  private player(id: string) { const player = this.players.find(item => item.id === id); if (!player) throw new Error('Unknown player.'); return player; }
  private alive(id: string) { const player = this.player(id); if (!player.alive) throw new Error('Dead player cannot act.'); return player; }
  private target(id: string, actorId?: string) { const target = this.alive(id); if (id === actorId) throw new Error('Self targeting is not legal for this action.'); return target; }
  publicState() {
    return { day: this.day, phase: this.phase, players: this.players.map(({ id, name, alive }) => ({ id, name, alive })),
      events: [...this.events], ...(this.winner ? { winner: this.winner, roles: this.players.map(({ id, role }) => ({ id, role })) } : {}) };
  }
  privateState(id: string) {
    const player = this.player(id);
    return { playerId: id, role: player.role, alive: player.alive,
      ...(player.role === 'wolf' ? { teammates: this.players.filter(item => item.role === 'wolf' && item.id !== id).map(item => item.id) } : {}),
      ...(player.role === 'seer' ? { visions: this.visions.get(id) ?? [] } : {}),
      ...(player.role === 'witch' ? { healingAvailable: this.healing, poisonAvailable: this.poison } : {}),
      ...(player.role === 'hunter' ? { shotAvailable: !this.hunterShot } : {}) };
  }
  nightVictim(votes: Record<string, string>) {
    const aliveWolves = this.players.filter(player => player.alive && player.role === 'wolf');
    if (Object.keys(votes).length !== aliveWolves.length || aliveWolves.some(player => !votes[player.id])) throw new Error('Each living wolf must choose once.');
    for (const [id, target] of Object.entries(votes)) if (this.alive(id).role !== 'wolf' || this.target(target).role === 'wolf') throw new Error('Illegal wolf choice.');
    return this.majority(Object.values(votes));
  }
  resolveNight(input: WerewolfNight) {
    if (this.phase !== 'night') throw new Error('Not a night phase.');
    const victimId = this.nightVictim(input.wolves);
    let vision: { actorId: string; targetId: string; wolf: boolean } | undefined;
    if (input.seer) {
      if (this.alive(input.seer.actorId).role !== 'seer') throw new Error('Only the seer may inspect.');
      const target = this.target(input.seer.targetId, input.seer.actorId);
      vision = { actorId: input.seer.actorId, targetId: target.id, wolf: target.role === 'wolf' };
    }
    let saved = false, poisonId: string | undefined;
    if (input.witch) {
      if (this.alive(input.witch.actorId).role !== 'witch') throw new Error('Only the witch may use potions.');
      if (input.witch.save) { if (!this.healing) throw new Error('Healing already spent.'); saved = true; }
      if (input.witch.poisonId) {
        if (!this.poison || input.witch.save) throw new Error('Only one available potion may be used per night.');
        this.target(input.witch.poisonId, input.witch.actorId); poisonId = input.witch.poisonId;
      }
    }
    if (saved) this.healing = false;
    if (poisonId) this.poison = false;
    if (vision) { const history = this.visions.get(vision.actorId) ?? [];
      history.push({ day: this.day, targetId: vision.targetId, wolf: vision.wolf }); this.visions.set(vision.actorId, history); }
    const deaths = [...new Set([...(saved ? [] : [victimId]), ...(poisonId ? [poisonId] : [])])];
    for (const id of deaths) this.player(id).alive = false;
    this.record('dawn', deaths.length ? `第${this.day}夜结束，死亡者：${deaths.join('、')}。` : `第${this.day}夜结束，平安夜。`);
    this.phase = 'day'; this.checkWinner(); return deaths;
  }
  speak(id: string, text: string) {
    if (this.phase !== 'day' || !text.trim() || text.length > 2000) throw new Error('Illegal day speech.');
    this.alive(id); return this.record('speech', text, id);
  }
  beginVote() { if (this.phase !== 'day') throw new Error('Not a day.'); this.phase = 'vote'; }
  resolveVote(votes: Record<string, string>) {
    if (this.phase !== 'vote') throw new Error('Not a vote phase.');
    const living = this.players.filter(player => player.alive);
    if (Object.keys(votes).length !== living.length || living.some(player => !votes[player.id])) throw new Error('Each living player votes once.');
    for (const [id, target] of Object.entries(votes)) { this.alive(id); this.target(target, id); }
    const eliminated = this.majority(Object.values(votes)); this.player(eliminated).alive = false;
    this.record('elimination', `第${this.day}天投票放逐${eliminated}。同票按公开座位顺序裁定。`, undefined, eliminated);
    this.checkWinner(); return eliminated;
  }
  hunterShoot(id: string, targetId?: string) {
    const hunter = this.player(id);
    if (hunter.role !== 'hunter' || hunter.alive || this.hunterShot) throw new Error('Hunter cannot shoot.');
    this.hunterShot = true;
    if (targetId) { this.target(targetId); this.player(targetId).alive = false; this.record('hunter', `猎人${id}开枪带走${targetId}。`, id, targetId); }
    this.checkWinner();
  }
  nextNight() {
    if (this.phase === 'finished') return;
    if (this.phase !== 'vote') throw new Error('Resolve the day before the next night.');
    this.day++; this.phase = 'night'; this.record('night', `进入第${this.day}夜。`);
  }
  private majority(ids: string[]) {
    const counts = new Map<string, number>(); for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || this.players.findIndex(player => player.id === a[0]) - this.players.findIndex(player => player.id === b[0]))[0]![0];
  }
  private checkWinner() {
    if (!this.hunterShot && this.players.some(player => player.role === 'hunter' && !player.alive)) return;
    const living = this.players.filter(player => player.alive), wolves = living.filter(player => player.role === 'wolf').length;
    if (!wolves || wolves >= living.length - wolves) {
      this.winner = wolves ? 'wolves' : 'village'; this.phase = 'finished'; this.record('finished', `对局结束，${this.winner}获胜。`);
    }
  }
}
