// The message field at the bottom of a session: text (16 px, so iOS doesn't zoom), up to four photos
// (downscaled on the phone before sending), Send, and Stop while Claude is working.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { downscaleImage } from "../lib/images";
import type { ImageUpload } from "../lib/protocol";
import { ArrowUp, Close, Photo, Stop } from "./icons";
import { Spinner, useApp } from "./ui";

const MAX_PHOTOS = 4;
const MAX_LINES_PX = 148;

interface PhotoDraft {
  id: number;
  preview: string;
  upload?: ImageUpload;
}

let photoSeq = 0;

const finePointer = (): boolean => {
  try {
    return window.matchMedia("(pointer: fine)").matches;
  } catch {
    return false;
  }
};

export interface ComposerProps {
  draftKey: string;
  /** Claude is working: show Stop. Sending still works (VS Code queues it). */
  running: boolean;
  /** Messages can go out now (connected, and not held while a new session starts); typing always works. */
  ready: boolean;
  placeholder: string;
  /** False: the message was not taken, and the text stays in the field. */
  onSend: (text: string, images: ImageUpload[]) => boolean;
  onStop: () => void;
}

export function Composer({ draftKey, running, ready: canGo, placeholder, onSend, onStop }: ComposerProps) {
  const { store } = useApp();
  const [text, setText] = useState(() => store.draft(draftKey));
  const [photos, setPhotos] = useState<PhotoDraft[]>([]);
  const area = useRef<HTMLTextAreaElement>(null);
  const previews = useRef(new Set<string>());

  // Grow with the text up to a few lines, then scroll inside.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_LINES_PX)}px`;
  }, [text]);

  useEffect(() => {
    const urls = previews.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);

  const ready = photos.every((p) => p.upload);
  const hasContent = text.trim().length > 0 || photos.length > 0;
  const sendable = canGo && hasContent && ready;

  const change = (value: string) => {
    setText(value);
    store.setDraft(draftKey, value);
  };

  const release = (photo: PhotoDraft) => {
    URL.revokeObjectURL(photo.preview);
    previews.current.delete(photo.preview);
  };

  const send = () => {
    if (!sendable) return;
    if (!onSend(text.trim(), photos.flatMap((p) => (p.upload ? [p.upload] : [])))) return;
    change("");
    photos.forEach(release);
    setPhotos([]);
  };

  const addFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const room = MAX_PHOTOS - photos.length;
    const files = [...list].slice(0, Math.max(0, room));
    if (list.length > room) store.toast(`Up to ${MAX_PHOTOS} photos per message`, "info");
    for (const file of files) {
      const id = ++photoSeq;
      const preview = URL.createObjectURL(file);
      previews.current.add(preview);
      setPhotos((prev) => [...prev, { id, preview }]);
      downscaleImage(file).then(
        (upload) => setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, upload } : p))),
        () => {
          setPhotos((prev) => prev.filter((p) => p.id !== id));
          URL.revokeObjectURL(preview);
          previews.current.delete(preview);
          store.toast("Couldn't read that photo", "error");
        },
      );
    }
  };

  const remove = (photo: PhotoDraft) => {
    release(photo);
    setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
  };

  return (
    <div class="composer">
      <label class={`attach ${photos.length >= MAX_PHOTOS ? "disabled" : ""}`} aria-label="Attach photos">
        <input
          class="visually-hidden"
          type="file"
          accept="image/*"
          multiple
          disabled={photos.length >= MAX_PHOTOS}
          onChange={(event) => {
            addFiles(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
        <Photo size={23} />
      </label>

      <div class="composer-field">
        {photos.length > 0 && (
          <div class="photos">
            {photos.map((photo) => (
              <div key={photo.id} class={`photo ${photo.upload ? "" : "busy"}`}>
                <img src={photo.preview} alt="Attached photo" />
                {!photo.upload && (
                  <span class="photo-busy">
                    <Spinner size={16} label="Preparing photo" />
                  </span>
                )}
                <button type="button" class="photo-remove" onClick={() => remove(photo)} aria-label="Remove photo">
                  <Close size={12} stroke={2.6} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label="Message"
          autocapitalize="sentences"
          onInput={(event) => change(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.isComposing && finePointer()) {
              event.preventDefault();
              send();
            }
          }}
        />
      </div>

      {running && (
        <button type="button" class="round-btn stop" onClick={onStop} aria-label="Stop Claude">
          <Stop size={20} />
        </button>
      )}
      <button type="button" class="round-btn send" disabled={!sendable} onClick={send} aria-label="Send">
        <ArrowUp size={20} stroke={2.4} />
      </button>
    </div>
  );
}
