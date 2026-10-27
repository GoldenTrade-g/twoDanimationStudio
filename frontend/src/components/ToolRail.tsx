/** Left tool rail + brush options popover in the right panel (options live in PropertiesPanel). */
import { useEditorState, useStore } from '../state/useStore';
import { TOOLS } from '../state/store';

const ICONS: Record<string, string> = {
  select: '⬚', move: '✥', pencil: '✏️', brush: '🖌️', eraser: '◻', line: '╱', rect: '▭',
  ellipse: '◯', polygon: '⬠', text: 'T', fill: '🪣', eyedropper: '💧', lasso: '➰', hand: '✋',
};

export function ToolRail(): JSX.Element {
  const store = useStore();
  const st = useEditorState();
  return (
    <div className="toolrail" role="toolbar" aria-orientation="vertical" aria-label="Drawing tools">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          title={`${t.label} (${t.shortcut}) — ${t.hint}`}
          aria-label={t.label}
          aria-keyshortcuts={t.shortcut}
          aria-pressed={st.tool === t.id}
          className={st.tool === t.id ? 'active' : ''}
          onClick={() => store.ui({ tool: t.id })}
        >
          {ICONS[t.id] ?? t.label[0]}
        </button>
      ))}
    </div>
  );
}
