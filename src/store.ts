import { create } from 'zustand';
import type { Project } from './core/types';
interface State {
  project: Project | null;
  past: Project[];
  future: Project[];
  dirty: boolean;
  saveState: string;
  setProject: (p: Project) => void;
  change: (p: Project) => void;
  undo: () => void;
  redo: () => void;
  markSaved: (revision: number, updatedAt: string) => void;
}
export const useStudio = create<State>((set, get) => ({
  project: null,
  past: [],
  future: [],
  dirty: false,
  saveState: '저장됨',
  setProject: (p) => set({ project: p, past: [], future: [], dirty: false, saveState: '저장됨' }),
  change: (p) =>
    set((s) => ({
      project: p,
      past: s.project ? [...s.past.slice(-199), s.project] : [],
      future: [],
      dirty: true,
      saveState: '저장 대기',
    })),
  undo: () => {
    const s = get();
    if (!s.past.length || !s.project) return;
    set({
      project: { ...s.past.at(-1)!, revision: s.project.revision },
      past: s.past.slice(0, -1),
      future: [s.project, ...s.future],
      dirty: true,
      saveState: '저장 대기',
    });
  },
  redo: () => {
    const s = get();
    if (!s.future.length || !s.project) return;
    set({
      project: { ...s.future[0], revision: s.project.revision },
      past: [...s.past, s.project],
      future: s.future.slice(1),
      dirty: true,
      saveState: '저장 대기',
    });
  },
  markSaved: (revision, updatedAt) =>
    set((s) => ({
      project: s.project ? { ...s.project, revision, updatedAt } : null,
      dirty: false,
      saveState: '로컬에 저장됨',
    })),
}));
