/** Bottom dock: Timeline / Storyboard / Audio tabs. */
import { useRef, useState } from 'react';
import type { AudioClip } from '@studio/shared';
import { useEditorState, useStore } from '../state/useStore';
import { Timeline } from './Timeline';
import { StoryboardPanel } from './StoryboardPanel';
import { AudioPanel } from './AudioPanel';

export function BottomDock(): JSX.Element {
  const [tab, setTab] = useState<'timeline' | 'storyboard' | 'audio'>('timeline');
  return (
    <div className="bottom">
      <div className="tabs" role="tablist" aria-label="Bottom panels">
        {(['timeline', 'storyboard', 'audio'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'timeline' ? '🎞 Timeline' : t === 'storyboard' ? '📋 Storyboard' : '🔊 Audio & Subtitles'}
          </button>
        ))}
      </div>
      <div className="panel-body" role="tabpanel">
        {tab === 'timeline' && <Timeline />}
        {tab === 'storyboard' && <StoryboardPanel />}
        {tab === 'audio' && <AudioPanel />}
      </div>
    </div>
  );
}
