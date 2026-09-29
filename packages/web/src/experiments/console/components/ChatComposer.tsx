import { Loader2, Mic, Paperclip, Square } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import {
  ACCEPTED_EXTENSIONS,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_FILE_MB,
  formatBytes,
  isAcceptedFileType,
} from '../primitives/file';
import { transcribe } from '../skills/voice';
import type { SlashCommand } from '../skills/conversations';

interface ChatComposerProps {
  onSend: (message: string, files?: File[]) => void;
  disabled: boolean;
  disabledReason?: string;
  /** The project's skills and commands, offered when the message starts with `/`. */
  commands?: SlashCommand[];
}

const MAX_HEIGHT = 200;

// Progressive dictation. A segment is cut at the first pause after
// SEGMENT_MIN_MS and at SEGMENT_MAX_MS regardless, which keeps every request
// inside one 30s Whisper window; while it runs, the whole segment so far is
// re-heard every PROVISIONAL_MS (skipped while one is in flight) so the text
// grows as it is spoken, and the segment's final transcript replaces it.
// ponytail: level-based pause detection; a cut mid-word at the cap can garble
// that one word. VAD on the ear would fix it if it shows up.
const CHUNK_MS = 500;
const LEVEL_MS = 100;
const PROVISIONAL_MS = 2000;
const SEGMENT_MIN_MS = 8000;
const SEGMENT_MAX_MS = 25000;
const PAUSE_MS = 600;
const QUIET_OVER_FLOOR = 3;
const QUIET_MIN_RMS = 0.004;
const FLOOR_DRIFT = 1.002;
const MENU_MAX = 8;
const NO_COMMANDS: SlashCommand[] = [];

interface Dictation {
  stream: MediaStream;
  audio: AudioContext;
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  mimeType: string;
  recorder: MediaRecorder;
  chunks: Blob[];
  seg: number;
  segStartedAt: number;
  quietSince: number | null;
  floor: number;
  /** Composer text before dictation plus every final transcript so far. */
  base: string;
  startLength: number;
  /** Provisional text of segments not yet final, by segment number. */
  heard: Map<number, string>;
  finals: Promise<void>;
  provisionalBusy: boolean;
  lastProvisionalAt: number;
  timer: ReturnType<typeof setInterval>;
}

function joinText(...parts: string[]): string {
  return parts
    .map(p => p.trim())
    .filter(p => p.length > 0)
    .join(' ');
}

function teardown(d: Dictation): void {
  d.stream.getTracks().forEach(t => {
    t.stop();
  });
  void d.audio.close();
}

interface PickedFile {
  file: File;
  id: string;
}

/**
 * Console-native chat composer. Auto-growing textarea, Enter sends,
 * Shift+Enter newline, Escape blurs. Attach files via the paperclip icon or by
 * pasting them (the send skill builds the multipart upload). The mic dictates
 * into the textarea: click to start, click again to stop and transcribe.
 *
 * Reimplemented (not imported) from the old chat's MessageInput because the
 * console may not import production `@/components/**` (ESLint isolation rule).
 *
 * Direction-B `cbox` shell: rounded card with `:focus-within` magenta ring,
 * paperclip attach + decorative `/` lead buttons, gradient `.brand-bar` Send
 * button + glow, kbd-hint row beneath. Attached files render as removable
 * chips above.
 */
export function ChatComposer({
  onSend,
  disabled,
  disabledReason,
  commands = NO_COMMANDS,
}: ChatComposerProps): ReactElement {
  const [value, setValue] = useState('');
  const [voice, setVoice] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);

  // Slash menu, as the terminal offers: open while the message is a bare
  // `/word`, name matches first, then description matches.
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuClosedFor, setMenuClosedFor] = useState<string | null>(null);
  const query = /^\/(\S*)$/.exec(value)?.[1]?.toLowerCase();
  const matches = useMemo(() => {
    if (query === undefined) return [];
    const byName = commands.filter(c => c.name.toLowerCase().includes(query));
    byName.sort(
      (a, b) =>
        Number(!a.name.toLowerCase().startsWith(query)) -
        Number(!b.name.toLowerCase().startsWith(query))
    );
    const byDescription = commands.filter(
      c => !byName.includes(c) && c.description.toLowerCase().includes(query)
    );
    return [...byName, ...byDescription].slice(0, MENU_MAX);
  }, [commands, query]);
  const menuOpen = matches.length > 0 && menuClosedFor !== value && voice === 'idle';
  useEffect(() => {
    setMenuIndex(0);
  }, [query]);

  const pickCommand = (command: SlashCommand): void => {
    setValue(`/${command.name} `);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el === null) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const idRef = useRef(0);

  // Dictation (PERS-23): one click starts capture, the next stops it. The text
  // writes itself into the composer as it is spoken and is never sent on its own.
  const dictationRef = useRef<Dictation | null>(null);

  useEffect(
    () => (): void => {
      const d = dictationRef.current;
      if (d === null) return;
      d.recorder.onstop = null;
      if (d.recorder.state !== 'inactive') d.recorder.stop();
      teardown(d);
    },
    []
  );

  const followEnd = (): void => {
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el === null) return;
      grow(el);
      el.scrollTop = el.scrollHeight;
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  // What the composer shows while dictating: the committed text, then every
  // segment still awaiting its final transcript, in the order spoken.
  const showDictation = (d: Dictation): void => {
    const pending = [...d.heard.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
    setValue(joinText(d.base, ...pending));
    followEnd();
  };

  // Each segment is its own recorder, so every blob sent is a whole webm file.
  const startSegment = (d: Dictation): void => {
    const recorder = new MediaRecorder(
      d.stream,
      d.mimeType !== '' ? { mimeType: d.mimeType } : undefined
    );
    const seg = ++d.seg;
    d.chunks = [];
    const chunks = d.chunks;
    recorder.ondataavailable = (e: BlobEvent): void => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = (): void => {
      const blob = new Blob(chunks, { type: recorder.mimeType });
      // Finals run in order, so the text commits in the order it was spoken.
      d.finals = d.finals.then(async () => {
        try {
          const text = chunks.length > 0 ? await transcribe(blob) : '';
          d.base = joinText(d.base, text);
        } catch (e: unknown) {
          setVoiceError(e instanceof Error ? e.message : 'Transcription failed.');
        }
        d.heard.delete(seg);
        showDictation(d);
      });
    };
    d.recorder = recorder;
    d.segStartedAt = Date.now();
    d.quietSince = null;
    recorder.start(CHUNK_MS);
  };

  // Called every LEVEL_MS: cut the segment at a pause once it is long enough,
  // or at the cap regardless; refresh the live segment's provisional text.
  const tickDictation = (d: Dictation): void => {
    d.analyser.getFloatTimeDomainData(d.samples);
    let sum = 0;
    for (const v of d.samples) sum += v * v;
    const rms = Math.sqrt(sum / d.samples.length);
    // Noise floor: the quietest level heard, drifting up slowly so one dead
    // instant does not make the room's own hum read as speech for good.
    d.floor = Math.min(rms, d.floor * FLOOR_DRIFT);
    const now = Date.now();
    if (rms < Math.max(d.floor * QUIET_OVER_FLOOR, QUIET_MIN_RMS)) d.quietSince ??= now;
    else d.quietSince = null;

    const age = now - d.segStartedAt;
    const paused = d.quietSince !== null && now - d.quietSince >= PAUSE_MS;
    if ((age >= SEGMENT_MIN_MS && paused) || age >= SEGMENT_MAX_MS) {
      const done = d.recorder;
      startSegment(d);
      done.stop();
      return;
    }

    if (d.provisionalBusy || now - d.lastProvisionalAt < PROVISIONAL_MS) return;
    if (d.chunks.length === 0) return;
    const seg = d.seg;
    const blob = new Blob(d.chunks, { type: d.recorder.mimeType });
    d.provisionalBusy = true;
    d.lastProvisionalAt = now;
    void transcribe(blob)
      .then(text => {
        // Ignore it if the segment's final already landed or recording stopped.
        if (dictationRef.current !== d || seg !== d.seg || text.length === 0) return;
        d.heard.set(seg, text);
        showDictation(d);
      })
      .catch(() => undefined)
      .finally(() => {
        d.provisionalBusy = false;
      });
  };

  const stopDictation = (d: Dictation): void => {
    clearInterval(d.timer);
    dictationRef.current = null;
    setVoice('transcribing');
    // The recorder's own onstop (registered first, so it runs first) queues the
    // last final; once it has, wait for every final, then release the mic.
    d.recorder.addEventListener(
      'stop',
      () => {
        void d.finals.then(() => {
          teardown(d);
          setVoice('idle');
          if (d.base.length === d.startLength) setVoiceError('Heard only silence.');
          textareaRef.current?.focus();
        });
      },
      { once: true }
    );
    d.recorder.stop();
  };

  const toggleVoice = async (): Promise<void> => {
    const running = dictationRef.current;
    if (running !== null) {
      stopDictation(running);
      return;
    }
    if (voice !== 'idle') return;
    setVoiceError(null);
    // Undefined outside a secure context: the LAN console is https for this.
    if (navigator.mediaDevices === undefined) {
      setVoiceError('Microphone needs https (or localhost).');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e: unknown) {
      setVoiceError(e instanceof Error ? `Microphone: ${e.message}` : 'Microphone refused.');
      return;
    }
    const audio = new AudioContext();
    // Created after an await, it can start suspended, and a suspended analyser
    // reads silence: every segment would then be cut at the first minimum.
    void audio.resume();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 2048;
    audio.createMediaStreamSource(stream).connect(analyser);
    const base = value.trim();
    const d: Dictation = {
      stream,
      audio,
      analyser,
      samples: new Float32Array(analyser.fftSize),
      mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : '',
      recorder: null as unknown as MediaRecorder,
      chunks: [],
      seg: 0,
      segStartedAt: 0,
      quietSince: null,
      floor: Infinity,
      base,
      startLength: base.length,
      heard: new Map(),
      finals: Promise.resolve(),
      provisionalBusy: false,
      lastProvisionalAt: Date.now(),
      timer: undefined as unknown as ReturnType<typeof setInterval>,
    };
    startSegment(d);
    d.timer = setInterval(() => {
      tickDictation(d);
    }, LEVEL_MS);
    dictationRef.current = d;
    setVoice('recording');
  };

  const grow = (el: HTMLTextAreaElement): void => {
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, MAX_HEIGHT);
    el.style.height = `${next.toString()}px`;
    el.style.overflowY = next >= MAX_HEIGHT ? 'auto' : 'hidden';
  };

  const addFiles = (incoming: File[]): void => {
    const next = [...files];
    // Accumulate every rejection reason (not just the last) so a mixed pick
    // surfaces all of them.
    const skipped: string[] = [];
    for (const file of incoming) {
      if (next.length >= MAX_FILES) {
        skipped.push(`${file.name}: over the ${String(MAX_FILES)}-file limit`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        skipped.push(`${file.name}: larger than ${String(MAX_FILE_MB)} MB`);
        continue;
      }
      if (!isAcceptedFileType(file)) {
        skipped.push(`${file.name}: unsupported type`);
        continue;
      }
      next.push({ file, id: String(idRef.current++) });
    }
    setFiles(next);
    setFileError(
      skipped.length > 0
        ? `Skipped ${String(skipped.length)} file(s) — ${skipped.join('; ')}`
        : null
    );
  };

  // Clipboard files (screenshots) join the paperclip's attachments. A clipboard
  // that also carries text (a spreadsheet range copies as text plus a picture)
  // pastes as text, which is what the copy meant.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const pasted = Array.from(e.clipboardData.files);
    if (pasted.length === 0 || e.clipboardData.types.includes('text/plain')) return;
    e.preventDefault();
    addFiles(pasted);
  };

  const removeFile = (id: string): void => {
    setFiles(prev => prev.filter(f => f.id !== id));
    setFileError(null);
  };

  const submit = (): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || disabled) return;
    onSend(trimmed, files.length > 0 ? files.map(f => f.file) : undefined);
    setValue('');
    setFiles([]);
    setFileError(null);
    if (fileInputRef.current !== null) fileInputRef.current.value = '';
    if (textareaRef.current !== null) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Don't submit while an IME composition is in progress (Japanese,
    // Chinese, Korean, etc. — the first Enter accepts a candidate).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (menuOpen) {
      const n = matches.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setMenuIndex(i => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        const chosen = matches[Math.min(menuIndex, n - 1)];
        if (chosen !== undefined) pickCommand(chosen);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenuClosedFor(value);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'Escape') {
      e.currentTarget.blur();
    }
  };

  return (
    <div
      className="shrink-0 border-t border-border bg-surface px-[30px] py-[14px]"
      title={disabledReason}
    >
      <div className="mx-auto max-w-[940px]">
        {files.length > 0 ? (
          <div className="mb-[10px] flex flex-wrap gap-[6px]">
            {files.map(f => (
              <span
                key={f.id}
                className="flex items-center gap-[6px] rounded-[8px] border bg-[color:var(--surface-elevated)] py-[4px] pl-[9px] pr-[5px] text-[11.5px]"
                style={{ borderColor: 'var(--border-bright)' }}
              >
                <span className="max-w-[180px] truncate text-text-primary">{f.file.name}</span>
                <span className="font-mono text-[10px] text-text-tertiary">
                  {formatBytes(f.file.size)}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    removeFile(f.id);
                  }}
                  aria-label={`Remove ${f.file.name}`}
                  className="rounded p-[1px] text-text-tertiary transition-colors hover:bg-[color:var(--surface-hover)] hover:text-text-primary"
                >
                  <span aria-hidden className="text-[11px] leading-none">
                    ✕
                  </span>
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {fileError !== null ? (
          <div className="mb-[8px] font-mono text-[11px] text-error">{fileError}</div>
        ) : null}
        {voiceError !== null ? (
          <div className="mb-[8px] font-mono text-[11px] text-error">{voiceError}</div>
        ) : null}
        {menuOpen ? (
          <div
            role="listbox"
            aria-label="Commands"
            className="mb-[8px] overflow-hidden rounded-[10px] border bg-[color:var(--surface-elevated)] py-[4px]"
            style={{ borderColor: 'var(--border-bright)' }}
          >
            {matches.map((c, i) => (
              <button
                key={c.name}
                type="button"
                role="option"
                aria-selected={i === menuIndex}
                onMouseDown={e => {
                  // Keep focus in the textarea.
                  e.preventDefault();
                  pickCommand(c);
                }}
                onMouseEnter={() => {
                  setMenuIndex(i);
                }}
                className={`flex w-full items-baseline gap-3 px-[12px] py-[5px] text-left ${
                  i === menuIndex ? 'bg-[color:var(--surface-hover)]' : ''
                }`}
              >
                <span className="shrink-0 font-mono text-[12.5px] text-text-primary">
                  /{c.name}
                  {c.argumentHint !== undefined ? (
                    <span className="text-text-tertiary"> {c.argumentHint}</span>
                  ) : null}
                </span>
                <span className="min-w-0 truncate text-[12px] text-text-tertiary">
                  {c.description}
                </span>
              </button>
            ))}
          </div>
        ) : null}
        <div
          className="flex items-end gap-[10px] rounded-[14px] border bg-[color:var(--surface-elevated)] py-[8px] pl-[14px] pr-[8px] transition-[border-color,box-shadow] focus-within:border-[color:color-mix(in_oklch,var(--brand-magenta),transparent_40%)] focus-within:shadow-[0_0_0_4px_color-mix(in_oklch,var(--brand-magenta),transparent_92%)]"
          style={{ borderColor: 'var(--border-bright)' }}
        >
          <div className="flex shrink-0 items-end gap-[6px] pb-[7px] text-text-tertiary">
            <button
              type="button"
              onClick={() => {
                fileInputRef.current?.click();
              }}
              aria-label="Attach files"
              disabled={disabled || files.length >= MAX_FILES}
              title="Attach files"
              className="flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-[color:var(--surface-hover)] hover:text-text-primary disabled:cursor-default disabled:opacity-50"
            >
              <Paperclip className="h-5 w-5" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPTED_EXTENSIONS}
              className="hidden"
              onChange={e => {
                if (e.target.files !== null) addFiles(Array.from(e.target.files));
              }}
            />
            <button
              type="button"
              onClick={() => {
                void toggleVoice();
              }}
              aria-label={voice === 'recording' ? 'Stop dictation' : 'Dictate'}
              aria-pressed={voice === 'recording'}
              disabled={disabled || voice === 'transcribing'}
              title={
                voice === 'recording'
                  ? 'Stop dictation'
                  : voice === 'transcribing'
                    ? 'Transcribing…'
                    : 'Dictate'
              }
              className={`flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-[color:var(--surface-hover)] hover:text-text-primary disabled:cursor-default disabled:opacity-50 ${
                voice === 'recording' ? 'animate-pulse text-[color:var(--accent)]' : ''
              }`}
            >
              {voice === 'recording' ? (
                <Square className="h-4 w-4 fill-current" />
              ) : voice === 'transcribing' ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Mic className="h-5 w-5" />
              )}
            </button>
            <button
              type="button"
              tabIndex={-1}
              aria-label="Commands"
              disabled={disabled || commands.length === 0 || voice !== 'idle'}
              onClick={() => {
                setMenuClosedFor(null);
                setValue('/');
                textareaRef.current?.focus();
              }}
              title="Commands"
              className="flex h-[22px] items-center justify-center rounded-md px-[2px] text-[17px] leading-none transition-colors hover:bg-[color:var(--surface-hover)] hover:text-text-primary disabled:cursor-default disabled:opacity-50"
            >
              /
            </button>
          </div>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={e => {
              setValue(e.target.value);
              grow(e.target);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            readOnly={voice !== 'idle'}
            rows={1}
            placeholder={disabled ? (disabledReason ?? 'Waiting…') : 'Message the agent…'}
            className="min-h-0 flex-1 resize-none bg-transparent py-[7px] text-[14.5px] leading-[1.5] text-text-primary placeholder:text-text-tertiary focus:outline-none disabled:opacity-50"
            style={{ maxHeight: `${MAX_HEIGHT.toString()}px` }}
          />
          <button
            type="button"
            onClick={submit}
            disabled={disabled || value.trim().length === 0}
            title="Send · Enter"
            className="brand-bar flex h-[36px] shrink-0 items-center gap-[7px] rounded-[10px] px-[15px] text-[13px] font-bold text-white shadow-[0_6px_18px_-8px_color-mix(in_oklch,var(--brand-magenta),transparent_30%)] transition-[filter,transform] hover:brightness-110 active:translate-y-[1px] disabled:opacity-45 disabled:shadow-none disabled:hover:brightness-100"
          >
            Send
            <span aria-hidden className="font-mono text-[10px] opacity-70">
              ↵
            </span>
          </button>
        </div>
        <div className="mt-[9px] flex items-center justify-between px-[2px] font-mono text-[11px] text-text-tertiary">
          <span />
          <span>
            <span
              className="mr-1 inline-flex items-center rounded border px-[5px] py-[1px] font-mono text-[10.5px] text-text-secondary"
              style={{ borderColor: 'var(--border-bright)' }}
            >
              ↵
            </span>
            send{' '}
            <span
              className="ml-1 inline-flex items-center rounded border px-[5px] py-[1px] font-mono text-[10.5px] text-text-secondary"
              style={{ borderColor: 'var(--border-bright)' }}
            >
              ⇧↵
            </span>{' '}
            newline
          </span>
        </div>
      </div>
    </div>
  );
}
