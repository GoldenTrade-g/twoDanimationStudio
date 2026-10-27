/** React binding for the framework-agnostic EditorStore. */
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { EditorStore } from './store';

const StoreContext = createContext<EditorStore | null>(null);

export function StoreProvider({ store, children }: { store: EditorStore; children: ReactNode }): JSX.Element {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): EditorStore {
  const s = useContext(StoreContext);
  if (!s) throw new Error('useStore must be used within StoreProvider');
  return s;
}

export function useEditorState() {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}
