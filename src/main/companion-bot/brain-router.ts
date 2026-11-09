import type { BotDshBrain } from './dsh-brain';
/** Native execution adapter protocol; there is no application agent/router model. */
export type BotBrain = Pick<BotDshBrain, 'run' | 'cancel' | 'cancelDurable' | 'send' | 'archive' | 'close'> & Partial<Pick<BotDshBrain,'compact'|'renameTopic'|'topicContext'>>;
