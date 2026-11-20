// Dictation: the microphone in the composer turns speech into text in the message field. It uses the
// browser's speech recognition (on the iPhone, Apple's dictation, in the chosen language). Words show up
// as they are heard; what the recognizer settles on replaces them. Nothing is sent until the user taps Send.

import type { StorageLike } from "./macs";

interface ResultLike {
  isFinal: boolean;
  0: { transcript: string };
}

export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ResultLike> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

export type RecognitionCtor = new () => RecognitionLike;

/** The browser's recognizer (`SpeechRecognition`, or Safari's `webkitSpeechRecognition`), or null. */
export function recognitionCtor(scope: object = globalThis): RecognitionCtor | null {
  const g = scope as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
}

export interface DictationHandlers {
  lang: string;
  /** Everything heard so far in this session: what is settled, and what is still being heard. */
  onText: (final: string, interim: string) => void;
  /** Listening ended; `problem` is the recognizer's error code, if there was one. */
  onEnd: (problem?: string) => void;
}

export class Dictation {
  readonly supported: boolean;
  listening = false;
  private readonly Ctor: RecognitionCtor | null;
  private recognition: RecognitionLike | null = null;

  constructor(Ctor: RecognitionCtor | null = recognitionCtor()) {
    this.Ctor = Ctor;
    this.supported = Ctor !== null;
  }

  /** Starts listening (call it from a tap). False when there is no recognizer or it refused to start. */
  start(handlers: DictationHandlers): boolean {
    if (!this.Ctor) return false;
    this.abort();
    let recognition: RecognitionLike;
    try {
      recognition = new this.Ctor();
    } catch {
      return false;
    }
    recognition.lang = handlers.lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    let problem: string | undefined;
    recognition.onresult = (event) => {
      if (this.recognition !== recognition) return;
      // The whole list each time: Safari can keep updating one result instead of adding new ones.
      let final = "";
      let interim = "";
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result?.[0]?.transcript ?? "";
        if (result?.isFinal) final += transcript;
        else interim += transcript;
      }
      handlers.onText(final.trim(), interim.trim());
    };
    recognition.onerror = (event) => {
      if (this.recognition === recognition) problem = event?.error;
    };
    recognition.onend = () => {
      if (this.recognition !== recognition) return;
      this.recognition = null;
      this.listening = false;
      handlers.onEnd(problem);
    };
    this.recognition = recognition;
    try {
      recognition.start();
    } catch {
      this.recognition = null;
      return false;
    }
    this.listening = true;
    return true;
  }

  /** Stops listening; what was heard so far still arrives, then the end. */
  stop(): void {
    try {
      this.recognition?.stop();
    } catch {
      // already stopped
    }
  }

  /** Drops the session at once, without its end (a new start, or the composer going away). */
  abort(): void {
    const recognition = this.recognition;
    if (!recognition) return;
    this.recognition = null;
    this.listening = false;
    try {
      recognition.abort();
    } catch {
      // already gone
    }
  }
}

/** Spoken words after what was typed: one space between them, none at the start of a line. */
export function mergeDictation(base: string, spoken: string): string {
  const words = spoken.trim();
  if (!words) return base;
  if (!base || /\s$/.test(base)) return base + words;
  return `${base} ${words}`;
}

/** What to tell the user when listening ended with an error; null when there is nothing to say. */
export function dictationProblem(code: string | undefined): { text: string; keyboard: boolean } | null {
  switch (code) {
    case undefined:
    case "":
    case "no-speech":
    case "aborted":
      return null;
    case "not-allowed":
      return { text: "Microphone access was denied. Allow the microphone for CCE Remote and try again.", keyboard: false };
    case "service-not-allowed":
      return { text: "Dictation isn't available in this app. Use the microphone on the keyboard instead.", keyboard: true };
    case "audio-capture":
      return { text: "No microphone is available.", keyboard: false };
    case "network":
      return { text: "Dictation needs a connection to Apple's speech service.", keyboard: false };
    default:
      return { text: `Dictation stopped (${code}).`, keyboard: false };
  }
}

// ---- the language -------------------------------------------------------------------------------

/** The choices in Settings: the phone's language, or a fixed one. */
export const DICTATION_LANGS = [
  { value: "auto", label: "Phone language" },
  { value: "en-US", label: "English" },
  { value: "de-DE", label: "Deutsch" },
] as const;

export type DictationLangChoice = (typeof DICTATION_LANGS)[number]["value"];

const LANG_KEY = "cce-remote:dictation-lang";

function storageOr(storage?: StorageLike): StorageLike | null {
  if (storage) return storage;
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadDictationLang(storage?: StorageLike): DictationLangChoice {
  try {
    const value = storageOr(storage)?.getItem(LANG_KEY);
    return DICTATION_LANGS.some((choice) => choice.value === value) ? (value as DictationLangChoice) : "auto";
  } catch {
    return "auto";
  }
}

export function saveDictationLang(choice: DictationLangChoice, storage?: StorageLike): void {
  try {
    storageOr(storage)?.setItem(LANG_KEY, choice);
  } catch {
    // not kept: the choice still applies until the app is closed
  }
}

/** The language tag to listen in: the chosen one, else the phone's, else English. */
export function dictationLang(choice: DictationLangChoice, phoneLanguage: string): string {
  if (choice !== "auto") return choice;
  return phoneLanguage || "en-US";
}
