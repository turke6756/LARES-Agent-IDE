/**
 * Crepe WYSIWYG editor — Phase 0 spike (plan §3, §7).
 *
 * Imperative mount on purpose (control + isolation; see plan §3 constraint 2):
 * the Crepe instance lives entirely inside useLayoutEffect, with destroy()
 * cleanup and a create-then-destroy sequencing guard so StrictMode's
 * mount → unmount → mount cycle never destroys an instance mid-create.
 *
 * Spike scope: content arrives via props; no store wiring; read-only of the
 * save path (typing works, nothing persists). WP1-B adds dirty tracking +
 * splice + saveTab.
 */
import React, { memo, useLayoutEffect, useRef } from 'react';
import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame-dark.css';

interface Props {
  content: string;
}

// Live instance accounting — exported for the leak unit test only.
let activeInstances = 0;
export function getActiveCrepeInstanceCount(): number {
  return activeInstances;
}

function MilkdownEditor({ content }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const crepe = new Crepe({
      root: container,
      defaultValue: content.replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
      features: {
        // explicit for the Gate 2 KaTeX/Vite font probe; on by default in 7.21.2
        [Crepe.Feature.Latex]: true,
      },
    });
    activeInstances += 1;

    const created = crepe.create().catch((err: unknown) => {
      console.error('[MilkdownEditor] crepe.create() failed', err);
      return null;
    });

    return () => {
      // Always wait for create() to settle before destroy() — under
      // StrictMode the cleanup runs while create() is still in flight.
      void created
        .then(() => crepe.destroy())
        .catch((err: unknown) => {
          console.error('[MilkdownEditor] crepe.destroy() failed', err);
        })
        .finally(() => {
          activeInstances -= 1;
        });
    };
  }, [content]);

  return <div ref={containerRef} className="milkdown-editor h-full overflow-auto" />;
}

// memo-isolated: parent/store updates with an unchanged `content` prop must
// never re-render (and thus never remount) the editor
export default memo(MilkdownEditor);
