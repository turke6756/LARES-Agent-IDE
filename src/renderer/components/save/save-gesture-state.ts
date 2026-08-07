import type { SaveRefusal, SaveRefusalStage } from '../../../shared/commit-candidates';
import type {
  SaveCardFleetAdhocMarkDoneSuccess,
  SaveCardPreviewResponse,
  SaveSweepResponse,
} from '../../../shared/types';
import type { CandidatePreviewDraft } from './CandidatePreview';

interface GestureContext {
  pins: SaveCardFleetAdhocMarkDoneSuccess[];
  draft: CandidatePreviewDraft | null;
}

export type SaveGestureState =
  | ({ status: 'idle' } & GestureContext)
  | ({ status: 'pinning' } & GestureContext)
  | ({ status: 'pinned' } & GestureContext)
  | ({ status: 'reviewing' } & GestureContext)
  | ({ status: 'sweeping' } & GestureContext)
  | ({ status: 'completed'; outcome: SaveSweepResponse } & GestureContext)
  | ({ status: 'refused'; refusal: SaveRefusal; latestPreview?: SaveCardPreviewResponse | null } & GestureContext)
  | ({
      status: 'uncertain';
      stage: Extract<SaveRefusalStage, 'token-consume' | 'commit' | 'reconciliation'>;
      code: 'repository-outcome-uncertain';
      message: string;
    } & GestureContext);

export type SaveGestureEvent =
  | { type: 'pin-started' }
  | { type: 'pins-updated'; pins: SaveCardFleetAdhocMarkDoneSuccess[]; complete: boolean }
  | { type: 'draft-updated'; draft: CandidatePreviewDraft }
  | { type: 'submit-stage'; stage: 'reviewing' | 'sweeping' }
  | { type: 'refused'; refusal: SaveRefusal; latestPreview?: SaveCardPreviewResponse | null }
  | {
      type: 'uncertain';
      stage: Extract<SaveRefusalStage, 'token-consume' | 'commit' | 'reconciliation'>;
      code: 'repository-outcome-uncertain';
      message: string;
    }
  | { type: 'completed'; outcome: SaveSweepResponse }
  | { type: 're-pin' }
  | { type: 'acknowledged' };

export const initialSaveGestureState: SaveGestureState = { status: 'idle', pins: [], draft: null };

export function saveGestureReducer(state: SaveGestureState, event: SaveGestureEvent): SaveGestureState {
  switch (event.type) {
    case 'pin-started':
      return { status: 'pinning', pins: state.pins, draft: state.draft };
    case 'pins-updated':
      return {
        status: event.complete ? 'pinned' : 'idle',
        pins: event.pins,
        draft: event.complete ? state.draft : null,
      };
    case 'draft-updated':
      return { ...state, draft: event.draft };
    case 'submit-stage':
      return { status: event.stage, pins: state.pins, draft: state.draft };
    case 'refused':
      return {
        status: 'refused', pins: state.pins, draft: state.draft,
        refusal: event.refusal,
        ...(event.latestPreview !== undefined ? { latestPreview: event.latestPreview } : {}),
      };
    case 'uncertain':
      return { status: 'uncertain', pins: state.pins, draft: state.draft, ...event };
    case 'completed':
      return { status: 'completed', pins: state.pins, draft: state.draft, outcome: event.outcome };
    case 're-pin':
      return { status: 'idle', pins: [], draft: state.draft };
    case 'acknowledged':
      return { status: 'idle', pins: [], draft: null };
  }
}
