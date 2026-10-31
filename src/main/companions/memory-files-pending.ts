import { CompanionModelAdmissionError } from './model-quota';
/** Known unfinished publication is a durable wait, never file authority or a
 * processing-quality failure. Committed missing/changed bytes use hard errors. */
export class CompanionMemoryFilesPending extends CompanionModelAdmissionError {
  constructor(message = '本次准确记忆修订仍在正式发布，后台会继续处理。') { super('files_pending', message); this.name = 'CompanionMemoryFilesPending'; }
}
