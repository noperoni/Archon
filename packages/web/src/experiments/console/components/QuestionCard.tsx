import { useState, type ReactElement } from 'react';
import type { PendingQuestion } from '../skills/messages';

interface QuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

interface QuestionCardProps {
  pending: PendingQuestion;
  onAnswer: (answers: Record<string, string>) => Promise<void>;
}

// The tool input is untrusted JSON from the model; anything malformed is dropped
// rather than rendered, and a card with no usable question shows nothing to click.
function readQuestions(input: Record<string, unknown>): Question[] {
  const raw = input.questions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((q: unknown): Question[] => {
    if (typeof q !== 'object' || q === null) return [];
    const { question, header, options, multiSelect } = q as Record<string, unknown>;
    if (typeof question !== 'string' || !Array.isArray(options)) return [];
    const opts = options.flatMap((o: unknown): QuestionOption[] => {
      if (typeof o !== 'object' || o === null) return [];
      const { label, description, preview } = o as Record<string, unknown>;
      return typeof label === 'string'
        ? [
            {
              label,
              description: typeof description === 'string' ? description : undefined,
              preview: typeof preview === 'string' ? preview : undefined,
            },
          ]
        : [];
    });
    return [
      {
        question,
        header: typeof header === 'string' ? header : undefined,
        options: opts,
        multiSelect: multiSelect === true,
      },
    ];
  });
}

/**
 * An AskUserQuestion call parked in the running turn. One choice per question
 * (several when multiSelect), or free text under "Other", as the terminal
 * offers. Submitting sends every question's answer at once, keyed by question
 * text, which is the shape Claude Code and the HK-47 gate's answer hook read.
 */
export function QuestionCard({ pending, onAnswer }: QuestionCardProps): ReactElement | null {
  const questions = readQuestions(pending.input);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (questions.length === 0) return null;

  const answerFor = (q: Question): string => {
    const labels = [...(picked[q.question] ?? [])];
    const typed = other[q.question]?.trim();
    if (typed) labels.push(typed);
    return labels.join(', ');
  };
  const complete = questions.every(q => answerFor(q).length > 0);

  const toggle = (q: Question, label: string): void => {
    setPicked(prev => {
      const current = prev[q.question] ?? [];
      if (!q.multiSelect) return { ...prev, [q.question]: [label] };
      return {
        ...prev,
        [q.question]: current.includes(label)
          ? current.filter(l => l !== label)
          : [...current, label],
      };
    });
    if (!q.multiSelect) setOther(prev => ({ ...prev, [q.question]: '' }));
  };

  const submit = (): void => {
    setSending(true);
    setError(null);
    const answers = Object.fromEntries(questions.map(q => [q.question, answerFor(q)]));
    onAnswer(answers).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : 'Answer failed.');
      setSending(false);
    });
  };

  return (
    <div className="mt-2 rounded border border-warning/30 bg-warning/[0.06] p-3">
      <p className="mb-3 text-[12px] uppercase tracking-[0.12em] text-warning">
        {pending.fromRun
          ? 'A workflow run is waiting on your answer'
          : 'The agent is waiting on your answer'}
      </p>
      <div className="flex flex-col gap-4">
        {questions.map(q => {
          const chosen = picked[q.question] ?? [];
          const preview = q.options.find(o => chosen.includes(o.label))?.preview;
          return (
            <fieldset key={q.question} className="flex flex-col gap-2" disabled={sending}>
              <legend className="mb-1.5 flex items-baseline gap-2 text-[13px] text-text-primary">
                {q.header !== undefined ? (
                  <span className="rounded border border-border px-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-text-tertiary">
                    {q.header}
                  </span>
                ) : null}
                <span>{q.question}</span>
              </legend>
              {q.options.map(o => (
                <label
                  key={o.label}
                  className="flex cursor-pointer items-start gap-2 rounded border border-border bg-surface-inset px-3 py-1.5 hover:border-border-bright"
                >
                  <input
                    type={q.multiSelect ? 'checkbox' : 'radio'}
                    name={`${pending.toolUseId}:${q.question}`}
                    checked={chosen.includes(o.label)}
                    onChange={(): void => {
                      toggle(q, o.label);
                    }}
                    className="mt-1"
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="break-words text-[13px] text-text-primary">{o.label}</span>
                    {o.description !== undefined ? (
                      <span className="text-[12px] text-text-tertiary">{o.description}</span>
                    ) : null}
                  </span>
                </label>
              ))}
              <input
                type="text"
                placeholder="Other"
                value={other[q.question] ?? ''}
                onChange={(e): void => {
                  const value = e.target.value;
                  setOther(prev => ({ ...prev, [q.question]: value }));
                  if (!q.multiSelect && value.trim()) {
                    setPicked(prev => ({ ...prev, [q.question]: [] }));
                  }
                }}
                className="rounded border border-border bg-surface-inset px-3 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-bright focus:outline-none disabled:opacity-50"
              />
              {preview !== undefined ? (
                <pre className="max-h-[320px] overflow-auto rounded border border-border bg-surface-inset p-2 font-mono text-[11px] leading-relaxed text-text-secondary">
                  {preview}
                </pre>
              ) : null}
            </fieldset>
          );
        })}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={!complete || sending}
          className="rounded border border-success/40 bg-success/15 px-3 py-1 text-[12px] font-medium text-success transition-colors hover:bg-success/25 disabled:opacity-50"
        >
          {sending ? 'Sending…' : 'Answer'}
        </button>
        {error !== null ? <span className="text-[12px] text-error">{error}</span> : null}
      </div>
    </div>
  );
}
