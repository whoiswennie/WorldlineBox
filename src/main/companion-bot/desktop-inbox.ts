import type { BotStore } from './store';

const key = 'desktop-message-inbox-v1';
type Counts = Record<string, number>;
export class DesktopInbox {
  private cursor: number;
  private counts: Counts = {};
  constructor(private store: BotStore, private changed: (counts: Counts) => void,
    private notify: (room: string, sender: string, preview: string) => void) {
    this.cursor = store.publicationHead();
    const raw = store.getMetadata(key);
    if (raw) {
      const saved = JSON.parse(raw);
      if (Number.isSafeInteger(saved.cursor) && saved.cursor <= this.cursor) {
        this.cursor = saved.cursor;
        this.counts = saved.counts ?? {};
      }
    }
    this.sync(false);
  }

  snapshot() { return { ...this.counts }; }

  read(room: string) {
    if (this.counts[room]) { delete this.counts[room]; this.save(); }
  }

  sync(alert = true) {
    const head = this.store.publicationHead();
    if (head === this.cursor && alert) return;
    const rooms = this.store.conversations().filter(room => !room.meeting && room.memberIds.includes('user')
      && (room.kind === 'group' || room.kind === 'direct')).map(room => room.id);
    const allowed = new Set(rooms);
    for (const id of Object.keys(this.counts)) if (!allowed.has(id) || this.cursor > head) delete this.counts[id];
    const latest = new Map<string, { sender: string; preview: string }>();
    do {
      const page = this.store.companionInbox(rooms, this.cursor);
      this.cursor = page.cursor;
      for (const msg of page.messages) {
        this.counts[msg.room] = (this.counts[msg.room] ?? 0) + 1;
        latest.set(msg.room, msg);
      }
      if (!page.more) break;
    } while (this.cursor < head);
    this.save();
    if (alert) for (const [room, msg] of latest) this.notify(room, msg.sender, msg.preview);
  }

  private save() {
    this.store.setMetadata(key, JSON.stringify({ cursor: this.cursor, counts: this.counts }));
    this.changed(this.counts);
  }
}
