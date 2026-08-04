import { create } from 'zustand';

interface PlansPaneState {
  expandedProposalId: string | null;
  setExpandedProposalId: (docId: string | null) => void;
}

/** Pane-level navigation state lives outside component lifetimes so switching panes stays authoritative. */
export const usePlansPaneState = create<PlansPaneState>((set) => ({
  expandedProposalId: null,
  setExpandedProposalId: (expandedProposalId) => set({ expandedProposalId }),
}));
