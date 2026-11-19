// The app's README, bundled at build time and shown inside the app (works offline, matches this build).

import readme from "../../README.md?raw";
import { Markdown } from "./Transcript";
import { NavBar, useApp } from "./ui";

export function Readme() {
  const { store } = useApp();
  return (
    <div class="screen readme">
      <NavBar onBack={() => store.back()} title="Read me" />
      <div class="scroll">
        <article class="readme-body">
          <Markdown text={readme} />
        </article>
      </div>
    </div>
  );
}
