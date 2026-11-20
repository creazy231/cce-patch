# Read aloud for CCE Remote — design

Date: 2026-11-20 · Status: decided autonomously. The user asked for "text to speech for the chat" and, in this project, for no questions. The calls we made are listed at the end.

## Intent

The user wants to follow a Claude Code session without looking at the phone, for example while walking. The phone reads Claude's replies aloud. Dictation, the other direction, is already in the iOS keyboard.

## Goals

- A speaker button on every Claude reply: tap to hear it, tap again to stop.
- "Read new replies aloud": while the app is open on a session, each new reply is read when it arrives, in order. It's off by default and switchable from the session's ••• menu and from Settings.
- Optional: when Claude asks a question or wants a permission, that is read too ("Claude asks: …"). It's off by default.
- It sounds right: German text gets a German voice and English text an English voice. Speed and voice can be chosen in Settings.
- Everything stays on the phone: the browser's speech API with the iPhone's own voices, no server, and no new dependency.

## Non-goals

- Reading while the app is in the background or the phone is locked. iOS suspends home-screen apps; push notifications cover that case.
- Reading tool calls, tool output, thinking or code.
- Voice input (the keyboard's dictation does it).

## Design

- **What is read.**
  - Only the text blocks of assistant messages, prepared for speech:
    - fenced code blocks are left out, with "code block" said once in their place;
    - inline code is read as plain text;
    - links are read by their label;
    - bare URLs become "link";
    - headings, list markers, emphasis, tables and HTML are reduced to their words.
  - A message without text (tool calls only) has no speaker button and is never read.
- **How it is read.**
  - The text is split into chunks of at most about 220 characters at sentence boundaries, since iOS cuts off long utterances, and queued in order.
  - Stop cancels the queue.
  - The language is detected per message: German or English by a small word and character heuristic, and anything unclear falls back to the phone's language.
  - The voice is the one chosen in Settings, or "Automatic": the best local voice for the detected language.
  - The speed is 0.8×, 1×, 1.25× or 1.5×.
- **Auto-read.**
  - It applies to messages that arrive live for the open session, never to the history loaded when a session opens, and never to your own messages.
  - Replies queue behind the one being read.
  - Leaving the session, closing the app or hiding it stops speech and drops the queue.
- **iOS rules.**
  - iOS lets speech start only from a tap at first. Turning auto-read on, or tapping a speaker button, counts as that tap.
  - If speech can't start, the app says "Tap a speaker button once to allow reading aloud".
- **UI.**
  - A speaker icon in the reply's footer turns into a stop icon while speaking.
  - While anything is being read, a small "Reading aloud · Stop" pill sits above the composer.
  - Settings gets a "Read aloud" group: new replies (toggle), questions (toggle), voice (picker), speed (picker).

## Decisions we made (for review)

- On-device speech only, using the Web Speech API.
- Auto-read and questions are off by default.
- German or English is detected per message, and the rest falls back to the device's language.
- Code is skipped, with one "code block" mention.
- Speech stops when the app is hidden.
