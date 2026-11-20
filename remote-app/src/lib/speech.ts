// Read aloud: Claude's replies spoken by the phone's own voices (the Web Speech API; nothing leaves the
// phone). Markdown is turned into what is worth hearing, the language is guessed per message so German
// text gets a German voice, and long text goes out in chunks, since iOS cuts long utterances off.
// The Speaker reads one chunk at a time and keeps its own queue, so it knows which message is being
// read and can drop the rest.

import type { StorageLike } from "./macs";

// ---- what is read -------------------------------------------------------------------------------

export function speechText(markdown: string): string {
  let s = markdown.replace(/\r\n?/g, "\n");
  s = s.replace(/(^|\n)\s*(```|~~~)[^\n]*\n[\s\S]*?(?:\n\s*\2[^\n]*(?=\n|$)|$)/g, "$1 code block. ");
  s = s.replace(/<[^>\n]+>/g, " ");
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/\bhttps?:\/\/[^\s)]+/g, "link");
  s = s.replace(/`([^`\n]+)`/g, "$1");
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  s = s.replace(/^[ \t]{0,3}>[ \t]?/gm, "");
  s = s.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "");
  s = s.replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, " ");
  s = s.replace(/\|/g, " ");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  s = s.replace(/\*([^*\n]+)\*/g, "$1");
  s = s.replace(/(^|[^\w])__([^_\n]+)__(?=[^\w]|$)/g, "$1$2");
  s = s.replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, "$1$2");
  s = s.replace(/~~([^~\n]+)~~/g, "$1");
  return s.replace(/\s+/g, " ").trim();
}

const GERMAN = new Set(
  "und der die das ist nicht ich mit für auf ein eine einen wir sie es den dem zu von auch sich noch wird sind oder aber wenn dass kann nur schon jetzt hier alle mehr bitte danke habe hast hat wurde werden".split(" "),
);
const ENGLISH = new Set("the and is are to of in it that this with for you on not be was have has can will i we they what which there done should would".split(" "));

/** 'de-DE' or 'en-US' when the words say so, else the fallback (the phone's language). */
export function detectLang(text: string, fallback: string): string {
  let de = /[äöüß]/i.test(text) ? 2 : 0;
  let en = 0;
  for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
    if (GERMAN.has(word)) de++;
    if (ENGLISH.has(word)) en++;
  }
  if (de > en) return "de-DE";
  if (en > de) return "en-US";
  return fallback;
}

/** Sentences packed into chunks of at most `max` characters; an overlong sentence is cut at a space. */
export function chunkText(text: string, max = 220): string[] {
  const chunks: string[] = [];
  const push = (part: string) => {
    const trimmed = part.trim();
    if (trimmed) chunks.push(trimmed);
  };
  let current = "";
  for (const raw of text.match(/[^.!?…]+(?:[.!?…]+|$)\s*/g) ?? []) {
    let sentence = raw;
    while (sentence.trim().length > max) {
      push(current);
      current = "";
      const head = sentence.trimStart();
      const space = head.lastIndexOf(" ", max);
      const at = space > 0 ? space : max;
      push(head.slice(0, at));
      sentence = head.slice(at);
    }
    if ((current + sentence).trim().length > max) {
      push(current);
      current = sentence;
    } else {
      current += sentence;
    }
  }
  push(current);
  return chunks;
}

// ---- voices -------------------------------------------------------------------------------------

export interface VoiceLike {
  voiceURI: string;
  name: string;
  lang: string;
  localService?: boolean;
  default?: boolean;
}

/** The chosen voice, else the best one for the language (local first), else the default voice. */
export function pickVoice<V extends VoiceLike>(voices: readonly V[], lang: string, preferred: string): V | null {
  if (preferred && preferred !== "auto") {
    const chosen = voices.find((voice) => voice.voiceURI === preferred);
    if (chosen) return chosen;
  }
  const norm = (value: string) => value.replace("_", "-").toLowerCase();
  const target = norm(lang);
  const prefix = target.split("-")[0];
  const best = (list: V[]) => list.find((voice) => voice.localService !== false) ?? list[0] ?? null;
  const exact = voices.filter((voice) => norm(voice.lang) === target);
  if (exact.length) return best(exact);
  const same = voices.filter((voice) => norm(voice.lang).split("-")[0] === prefix);
  if (same.length) return best(same);
  return voices.find((voice) => voice.default) ?? null;
}

// ---- preferences --------------------------------------------------------------------------------

export interface SpeechPrefs {
  /** Read new replies of the open session while the app is in front. */
  replies: boolean;
  /** Read new questions and permission prompts too. */
  questions: boolean;
  /** 'auto' or a voiceURI. */
  voice: string;
  rate: number;
}

export const SPEECH_RATES = [0.8, 1, 1.25, 1.5] as const;
export const DEFAULT_SPEECH_PREFS: SpeechPrefs = { replies: false, questions: false, voice: "auto", rate: 1 };
const PREFS_KEY = "cce-remote:speech";

function storageOr(storage?: StorageLike): StorageLike | null {
  if (storage) return storage;
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadSpeechPrefs(storage?: StorageLike): SpeechPrefs {
  try {
    const raw = storageOr(storage)?.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_SPEECH_PREFS };
    const value = JSON.parse(raw) as Partial<Record<keyof SpeechPrefs, unknown>>;
    return {
      replies: typeof value.replies === "boolean" ? value.replies : DEFAULT_SPEECH_PREFS.replies,
      questions: typeof value.questions === "boolean" ? value.questions : DEFAULT_SPEECH_PREFS.questions,
      voice: typeof value.voice === "string" && value.voice ? value.voice : DEFAULT_SPEECH_PREFS.voice,
      rate: typeof value.rate === "number" && (SPEECH_RATES as readonly number[]).includes(value.rate) ? value.rate : DEFAULT_SPEECH_PREFS.rate,
    };
  } catch {
    return { ...DEFAULT_SPEECH_PREFS };
  }
}

export function saveSpeechPrefs(prefs: SpeechPrefs, storage?: StorageLike): void {
  try {
    storageOr(storage)?.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // not kept: the prefs still apply until the app is closed
  }
}

// ---- the speaker --------------------------------------------------------------------------------

export interface UtteranceLike {
  lang: string;
  voice: VoiceLike | null;
  rate: number;
  volume: number;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}

export interface SpeechEnv {
  synth: { speak(utterance: UtteranceLike): void; cancel(): void; getVoices(): VoiceLike[] } | undefined;
  Utterance: new (text: string) => UtteranceLike;
  /** Runs `fn` a moment later: iOS drops a speak() that follows cancel() at once. */
  defer: (fn: () => void) => void;
}

export interface SpeakOptions {
  voice: string;
  rate: number;
  /** The phone's language, for text that is neither clearly German nor English. */
  fallbackLang: string;
}

/** What the store needs of a Speaker (tests hand in a fake). */
export type SpeakerLike = Pick<Speaker, "supported" | "current" | "blocked" | "onChange" | "voices" | "speak" | "enqueue" | "stop" | "unlock">;

interface QueueItem {
  id: string;
  chunks: string[];
  lang: string;
  voice: VoiceLike | null;
  rate: number;
}

function browserEnv(): SpeechEnv {
  const g = globalThis as { speechSynthesis?: SpeechEnv["synth"]; SpeechSynthesisUtterance?: SpeechEnv["Utterance"] };
  return {
    synth: g.speechSynthesis && g.SpeechSynthesisUtterance ? g.speechSynthesis : undefined,
    Utterance: g.SpeechSynthesisUtterance ?? (class {} as unknown as SpeechEnv["Utterance"]),
    defer: (fn) => void setTimeout(fn, 80),
  };
}

export class Speaker {
  readonly supported: boolean;
  /** The id of the item being read, or null. */
  current: string | null = null;
  /** iOS refused to start speech that no tap started; a tap on a speaker button clears it. */
  blocked = false;
  private readonly env: SpeechEnv;
  private queue: QueueItem[] = [];
  private active: UtteranceLike | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(env: SpeechEnv = browserEnv()) {
    this.env = env;
    this.supported = env.synth !== undefined;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  voices(): VoiceLike[] {
    try {
      return this.env.synth?.getVoices() ?? [];
    } catch {
      return [];
    }
  }

  /** Reads this item now, instead of whatever is playing or queued. */
  speak(id: string, markdown: string, options: SpeakOptions): void {
    this.blocked = false;
    const item = this.prepare(id, markdown, options);
    const wasPlaying = this.cancel();
    if (!item) {
      this.setCurrent(null);
      return;
    }
    this.queue = [item];
    // Started by a tap with nothing playing: speak at once, inside the tap (iOS needs that the first time).
    if (wasPlaying) this.env.defer(() => this.play());
    else this.play();
  }

  /** Reads this item after whatever is playing or queued. */
  enqueue(id: string, markdown: string, options: SpeakOptions): void {
    const item = this.prepare(id, markdown, options);
    if (!item) return;
    this.queue.push(item);
    this.play();
  }

  stop(): void {
    this.cancel();
    this.setCurrent(null);
  }

  /** A silent utterance, spoken inside a tap: lets later replies be read without one (iOS). */
  unlock(): void {
    if (!this.env.synth) return;
    try {
      const utterance = new this.env.Utterance(" ");
      utterance.volume = 0;
      this.env.synth.speak(utterance);
    } catch {
      // nothing to unlock
    }
  }

  private prepare(id: string, markdown: string, options: SpeakOptions): QueueItem | null {
    if (!this.env.synth) return null;
    const text = speechText(markdown);
    const chunks = chunkText(text);
    if (!chunks.length) return null;
    const lang = detectLang(text, options.fallbackLang);
    const voice = pickVoice(this.voices(), lang, options.voice);
    return { id, chunks, lang: options.voice !== "auto" && voice ? voice.lang : lang, voice, rate: options.rate };
  }

  /** Drops the queue and cancels the utterance that plays; true when something was playing. */
  private cancel(): boolean {
    this.queue = [];
    if (!this.active) return false;
    this.active = null;
    try {
      this.env.synth?.cancel();
    } catch {
      // already quiet
    }
    return true;
  }

  private play(): void {
    if (this.active || !this.env.synth) return;
    const item = this.queue[0];
    if (!item) {
      this.setCurrent(null);
      return;
    }
    const text = item.chunks.shift();
    if (text === undefined) {
      this.queue.shift();
      this.play();
      return;
    }
    this.setCurrent(item.id);
    const utterance = new this.env.Utterance(text);
    utterance.lang = item.lang;
    if (item.voice) utterance.voice = item.voice;
    utterance.rate = item.rate;
    utterance.onend = () => {
      if (this.active !== utterance) return; // a cancelled one
      this.active = null;
      this.play();
    };
    utterance.onerror = (event) => {
      if (this.active !== utterance) return;
      this.active = null;
      if (event?.error === "not-allowed") {
        this.blocked = true;
        this.queue = [];
        this.setCurrent(null, true);
        return;
      }
      this.play();
    };
    this.active = utterance;
    try {
      this.env.synth.speak(utterance);
    } catch {
      this.active = null;
      this.queue = [];
      this.setCurrent(null);
    }
  }

  private setCurrent(id: string | null, force = false): void {
    if (this.current === id && !force) return;
    this.current = id;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // a listener's problem
      }
    }
  }
}
