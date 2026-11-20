import { describe, expect, test } from "bun:test";
import { Dictation, dictationLang, dictationProblem, loadDictationLang, mergeDictation, recognitionCtor, saveDictationLang, type RecognitionLike } from "../src/lib/dictation";

// ---- a fake recognizer: results arrive as the browser's SpeechRecognitionEvent would hand them ----

type Result = { isFinal: boolean; 0: { transcript: string }; length: 1 };
const result = (transcript: string, isFinal: boolean): Result => ({ isFinal, 0: { transcript }, length: 1 });

class FakeRecognition implements RecognitionLike {
  static last: FakeRecognition | null = null;
  lang = "";
  continuous = false;
  interimResults = false;
  started = 0;
  stopped = 0;
  aborted = 0;
  failStart = false;
  onresult: ((event: { resultIndex: number; results: ArrayLike<Result> }) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() {
    FakeRecognition.last = this;
  }
  start() {
    if (this.failStart) throw new Error("InvalidStateError");
    this.started++;
  }
  stop() {
    this.stopped++;
  }
  abort() {
    this.aborted++;
  }
  emit(results: Result[], resultIndex = 0) {
    this.onresult?.({ resultIndex, results });
  }
}

describe("Dictation", () => {
  test("listens continuously in the given language, with words as they come", () => {
    const dictation = new Dictation(FakeRecognition);
    expect(dictation.supported).toBe(true);
    const ok = dictation.start({ lang: "de-DE", onText: () => {}, onEnd: () => {} });
    expect(ok).toBe(true);
    const rec = FakeRecognition.last!;
    expect([rec.lang, rec.continuous, rec.interimResults, rec.started]).toEqual(["de-DE", true, true, 1]);
    expect(dictation.listening).toBe(true);
  });

  test("hands over what is final and what is still being heard", () => {
    const texts: Array<[string, string]> = [];
    const dictation = new Dictation(FakeRecognition);
    dictation.start({ lang: "en-US", onText: (final, interim) => texts.push([final, interim]), onEnd: () => {} });
    const rec = FakeRecognition.last!;
    rec.emit([result("hello", false)]);
    rec.emit([result("hello world", true)]);
    rec.emit([result("hello world", true), result(" how are", false)], 1);
    expect(texts).toEqual([
      ["", "hello"],
      ["hello world", ""],
      ["hello world", "how are"],
    ]);
  });

  test("stop ends listening and the end reports no problem", () => {
    const ends: Array<string | undefined> = [];
    const dictation = new Dictation(FakeRecognition);
    dictation.start({ lang: "en-US", onText: () => {}, onEnd: (problem) => ends.push(problem) });
    dictation.stop();
    const rec = FakeRecognition.last!;
    expect(rec.stopped).toBe(1);
    rec.onend?.();
    expect(dictation.listening).toBe(false);
    expect(ends).toEqual([undefined]);
  });

  test("an error is reported with the end", () => {
    const ends: Array<string | undefined> = [];
    const dictation = new Dictation(FakeRecognition);
    dictation.start({ lang: "en-US", onText: () => {}, onEnd: (problem) => ends.push(problem) });
    const rec = FakeRecognition.last!;
    rec.onerror?.({ error: "not-allowed" });
    rec.onend?.();
    expect(ends).toEqual(["not-allowed"]);
  });

  test("a recognizer that won't start, or none at all, says so", () => {
    const failing = class extends FakeRecognition {
      constructor() {
        super();
        this.failStart = true;
      }
    };
    expect(new Dictation(failing).start({ lang: "en-US", onText: () => {}, onEnd: () => {} })).toBe(false);
    const none = new Dictation(null);
    expect(none.supported).toBe(false);
    expect(none.start({ lang: "en-US", onText: () => {}, onEnd: () => {} })).toBe(false);
  });

  test("starting again while listening restarts cleanly", () => {
    const dictation = new Dictation(FakeRecognition);
    dictation.start({ lang: "en-US", onText: () => {}, onEnd: () => {} });
    const first = FakeRecognition.last!;
    dictation.start({ lang: "en-US", onText: () => {}, onEnd: () => {} });
    expect(first.aborted).toBe(1);
    expect(FakeRecognition.last).not.toBe(first);
  });
});

describe("mergeDictation", () => {
  test("adds spoken words after what was typed, with one space", () => {
    expect(mergeDictation("", " Hello there ")).toBe("Hello there");
    expect(mergeDictation("Fix", "the tests")).toBe("Fix the tests");
    expect(mergeDictation("Fix ", "the tests")).toBe("Fix the tests");
    expect(mergeDictation("Line one\n", "line two")).toBe("Line one\nline two");
    expect(mergeDictation("Typed", "")).toBe("Typed");
  });
});

describe("dictationProblem", () => {
  test("says what to do, or nothing for a quiet end", () => {
    expect(dictationProblem("not-allowed")?.text).toBe("Microphone access was denied. Allow the microphone for CCE Remote and try again.");
    expect(dictationProblem("service-not-allowed")).toEqual({ text: "Dictation isn't available in this app. Use the microphone on the keyboard instead.", keyboard: true });
    expect(dictationProblem("audio-capture")?.text).toBe("No microphone is available.");
    expect(dictationProblem("network")?.text).toBe("Dictation needs a connection to Apple's speech service.");
    expect(dictationProblem("no-speech")).toBeNull();
    expect(dictationProblem("aborted")).toBeNull();
    expect(dictationProblem(undefined)).toBeNull();
    expect(dictationProblem("something-else")?.text).toBe("Dictation stopped (something-else).");
  });
});

describe("the dictation language", () => {
  test("phone language by default, a chosen one is kept, and it resolves to a language tag", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
    expect(loadDictationLang(storage)).toBe("auto");
    saveDictationLang("en-US", storage);
    expect(loadDictationLang(storage)).toBe("en-US");
    data.set("cce-remote:dictation-lang", "xx");
    expect(loadDictationLang(storage)).toBe("auto");
    expect(dictationLang("auto", "de-DE")).toBe("de-DE");
    expect(dictationLang("auto", "")).toBe("en-US");
    expect(dictationLang("en-US", "de-DE")).toBe("en-US");
  });
});

describe("recognitionCtor", () => {
  test("finds the browser's recognizer, prefixed or not", () => {
    expect(recognitionCtor({ SpeechRecognition: FakeRecognition })).toBe(FakeRecognition);
    expect(recognitionCtor({ webkitSpeechRecognition: FakeRecognition })).toBe(FakeRecognition);
    expect(recognitionCtor({})).toBeNull();
  });
});
