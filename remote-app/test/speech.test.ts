import { describe, expect, test } from "bun:test";
import { chunkText, detectLang, loadSpeechPrefs, pickVoice, saveSpeechPrefs, Speaker, speechText, type SpeechEnv, type VoiceLike } from "../src/lib/speech";

describe("speechText", () => {
  test("leaves out code blocks, with one mention", () => {
    expect(speechText("Run this:\n\n```sh\nnpm test\n```\n\nThen it works.")).toBe("Run this: code block. Then it works.");
  });
  test("reads inline code, link labels and says link for bare URLs", () => {
    expect(speechText("Open `patch.ts` in [the repo](https://example.com/x) or https://example.com/y now.")).toBe("Open patch.ts in the repo or link now.");
  });
  test("drops headings, list markers, quotes, emphasis, tables and HTML", () => {
    const md = "## Done\n\n- **Fixed** the _bug_\n1. Ran tests\n> quoted\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<br/>end ~~old~~";
    expect(speechText(md)).toBe("Done Fixed the bug Ran tests quoted a b 1 2 end old");
  });
  test("keeps underscores inside words", () => {
    expect(speechText("set file_path and max_len")).toBe("set file_path and max_len");
  });
  test("collapses whitespace", () => {
    expect(speechText("  a \n\n  b\t c  ")).toBe("a b c");
  });
});

describe("detectLang", () => {
  test("German", () => {
    expect(detectLang("Ich habe die Datei geändert und die Tests laufen.", "en-US")).toBe("de-DE");
  });
  test("English", () => {
    expect(detectLang("I changed the file and the tests pass.", "de-DE")).toBe("en-US");
  });
  test("unclear text falls back", () => {
    expect(detectLang("OK", "en-GB")).toBe("en-GB");
  });
});

describe("chunkText", () => {
  test("short text is one chunk", () => {
    expect(chunkText("Hello there. How are you?")).toEqual(["Hello there. How are you?"]);
  });
  test("long text is split at sentence ends", () => {
    const a = "A".repeat(150) + ".";
    const b = "B".repeat(150) + ".";
    expect(chunkText(`${a} ${b}`, 220)).toEqual([a, b]);
  });
  test("a long sentence is split at a space", () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkText(words, 100);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join(" ")).toBe(words);
  });
  test("one huge word is cut hard", () => {
    expect(chunkText("x".repeat(500), 220).map((c) => c.length)).toEqual([220, 220, 60]);
  });
  test("no empty chunks", () => {
    expect(chunkText("   ")).toEqual([]);
  });
});

describe("pickVoice", () => {
  const voices: VoiceLike[] = [
    { voiceURI: "en-remote", name: "Remote", lang: "en-US", localService: false },
    { voiceURI: "en-local", name: "Samantha", lang: "en-US", localService: true, default: true },
    { voiceURI: "de-at", name: "Anna AT", lang: "de-AT", localService: true },
  ];
  test("the chosen voice", () => {
    expect(pickVoice(voices, "de-DE", "en-remote")?.voiceURI).toBe("en-remote");
  });
  test("an exact language match, local first", () => {
    expect(pickVoice(voices, "en-US", "auto")?.voiceURI).toBe("en-local");
  });
  test("the same language in another region", () => {
    expect(pickVoice(voices, "de-DE", "auto")?.voiceURI).toBe("de-at");
  });
  test("the default voice", () => {
    expect(pickVoice(voices, "fr-FR", "auto")?.voiceURI).toBe("en-local");
  });
  test("none", () => {
    expect(pickVoice([], "fr-FR", "auto")).toBeNull();
  });
});

describe("speech prefs", () => {
  test("defaults, and what is saved comes back", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
    expect(loadSpeechPrefs(storage)).toEqual({ replies: false, questions: false, voice: "auto", rate: 1 });
    saveSpeechPrefs({ replies: true, questions: true, voice: "x", rate: 1.25 }, storage);
    expect(loadSpeechPrefs(storage)).toEqual({ replies: true, questions: true, voice: "x", rate: 1.25 });
    data.set("cce-remote:speech", "{not json");
    expect(loadSpeechPrefs(storage)).toEqual({ replies: false, questions: false, voice: "auto", rate: 1 });
    data.set("cce-remote:speech", JSON.stringify({ replies: "yes", rate: 9 }));
    expect(loadSpeechPrefs(storage)).toEqual({ replies: false, questions: false, voice: "auto", rate: 1 });
  });
});

// ---- the speaker, with a fake speech engine ----

class FakeUtterance {
  lang = "";
  voice: VoiceLike | null = null;
  rate = 1;
  volume = 1;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(readonly text: string) {}
}

function fakeEnv(voices: VoiceLike[] = []) {
  const spoken: FakeUtterance[] = [];
  let cancels = 0;
  const env: SpeechEnv = {
    synth: {
      speak: (u) => void spoken.push(u as FakeUtterance),
      cancel: () => void cancels++,
      getVoices: () => voices,
    },
    Utterance: FakeUtterance,
    defer: (fn) => fn(),
  };
  return { env, spoken, cancels: () => cancels, finish: (u: FakeUtterance) => u.onend?.() };
}

const opts = { voice: "auto", rate: 1.25, fallbackLang: "en-US" };

describe("Speaker", () => {
  test("reads the chunks of a message one after another", () => {
    const { env, spoken, finish } = fakeEnv();
    const speaker = new Speaker(env);
    const changes: Array<string | null> = [];
    speaker.onChange(() => changes.push(speaker.current));
    speaker.speak("m1", `${"A".repeat(150)}. ${"B".repeat(150)}.`, opts);
    expect(speaker.current).toBe("m1");
    expect(spoken.length).toBe(1);
    expect(spoken[0].rate).toBe(1.25);
    expect(spoken[0].lang).toBe("en-US");
    finish(spoken[0]);
    expect(spoken.length).toBe(2);
    finish(spoken[1]);
    expect(speaker.current).toBeNull();
    expect(changes).toEqual(["m1", null]);
  });

  test("stop cancels and forgets the queue", () => {
    const { env, spoken, cancels, finish } = fakeEnv();
    const speaker = new Speaker(env);
    speaker.speak("m1", "First message.", opts);
    speaker.enqueue("m2", "Second message.", opts);
    speaker.stop();
    expect(cancels()).toBe(1);
    expect(speaker.current).toBeNull();
    finish(spoken[0]); // a late end of the cancelled utterance changes nothing
    expect(spoken.length).toBe(1);
    expect(speaker.current).toBeNull();
  });

  test("enqueue reads after what is playing; speak replaces it", () => {
    const { env, spoken, finish } = fakeEnv();
    const speaker = new Speaker(env);
    speaker.speak("m1", "One.", opts);
    speaker.enqueue("m2", "Two.", opts);
    expect(spoken.map((u) => u.text)).toEqual(["One."]);
    finish(spoken[0]);
    expect(speaker.current).toBe("m2");
    expect(spoken.map((u) => u.text)).toEqual(["One.", "Two."]);
    speaker.speak("m3", "Three.", opts);
    expect(speaker.current).toBe("m3");
    expect(spoken.at(-1)?.text).toBe("Three.");
  });

  test("picks the voice for the language of each message", () => {
    const voices: VoiceLike[] = [
      { voiceURI: "en", name: "Samantha", lang: "en-US", localService: true },
      { voiceURI: "de", name: "Anna", lang: "de-DE", localService: true },
    ];
    const { env, spoken } = fakeEnv(voices);
    new Speaker(env).speak("m1", "Ich habe die Datei geändert und die Tests laufen.", opts);
    expect(spoken[0].lang).toBe("de-DE");
    expect(spoken[0].voice?.voiceURI).toBe("de");
  });

  test("a message without words is not read", () => {
    const { env, spoken } = fakeEnv();
    const speaker = new Speaker(env);
    speaker.speak("m1", "   ", opts);
    speaker.enqueue("m2", "", opts);
    expect(spoken.length).toBe(0);
    expect(speaker.current).toBeNull();
  });

  test("iOS refusing to speak before a tap marks it blocked", () => {
    const { env, spoken } = fakeEnv();
    const speaker = new Speaker(env);
    speaker.enqueue("m1", "Hello there.", opts);
    spoken[0].onerror?.({ error: "not-allowed" });
    expect(speaker.blocked).toBe(true);
    expect(speaker.current).toBeNull();
    speaker.speak("m2", "Again.", opts);
    expect(speaker.blocked).toBe(false);
  });

  test("without speech support nothing happens", () => {
    const speaker = new Speaker({ synth: undefined, Utterance: FakeUtterance, defer: (fn) => fn() });
    expect(speaker.supported).toBe(false);
    speaker.speak("m1", "Hello.", opts);
    expect(speaker.current).toBeNull();
  });

  test("unlock speaks a silent utterance", () => {
    const { env, spoken } = fakeEnv();
    new Speaker(env).unlock();
    expect(spoken.length).toBe(1);
    expect(spoken[0].volume).toBe(0);
  });
});
