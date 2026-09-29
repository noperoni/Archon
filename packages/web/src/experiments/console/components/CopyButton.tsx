import { Check, Copy, X } from 'lucide-react';
import { useState, type MouseEvent, type ReactElement } from 'react';

type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Copy `text` and report how it went for 1.5s. The console is only ever served
 * from a secure context (localhost or the https LAN host), so the async
 * clipboard is always there; a refusal still shows, it is never swallowed.
 */
export function useCopy(): [CopyState, (text: string) => void] {
  const [state, setState] = useState<CopyState>('idle');
  const copy = (text: string): void => {
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(
        () => {
          setState('copied');
        },
        () => {
          setState('failed');
        }
      )
      .finally(() => {
        setTimeout(() => {
          setState('idle');
        }, 1500);
      });
  };
  return [state, copy];
}

interface CopyButtonProps {
  /** Read at click time, so a streamed block copies what is on screen now. */
  getText: () => string;
  className?: string;
}

export function CopyButton({ getText, className = '' }: CopyButtonProps): ReactElement {
  const [state, copy] = useCopy();
  return (
    <button
      type="button"
      onClick={(e: MouseEvent): void => {
        e.stopPropagation();
        copy(getText());
      }}
      aria-label="Copy"
      title={state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy refused' : 'Copy'}
      className={`flex h-[24px] w-[24px] items-center justify-center rounded-md border bg-[color:var(--surface-elevated)] text-text-tertiary transition-[opacity,color] hover:text-text-primary ${className}`}
      style={{
        borderColor: 'var(--border-bright)',
        color:
          state === 'copied' ? 'var(--success)' : state === 'failed' ? 'var(--error)' : undefined,
      }}
    >
      {state === 'copied' ? (
        <Check className="h-3.5 w-3.5" />
      ) : state === 'failed' ? (
        <X className="h-3.5 w-3.5" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}
