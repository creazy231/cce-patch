# Claude Commit Message

Adds **Generate Commit Message with Claude** to the Source Control view. It does what the
built-in ✨ "Generate Commit Message" button does: it reads the staged changes (or all
changes when nothing is staged) and the recent commit messages, follows your
`github.copilot.chat.commitMessageGeneration.instructions`, and puts the message in the
commit message box. The difference is that Claude writes it, through your Claude Code login.

- The button sits in the commit message box. Until VS Code allows that (see below), it sits in
  the title bar of the **Changes** view instead. While it runs, the button turns into a stop
  button.
- `claudeCommit.model`: `haiku` (default, fastest), `sonnet`, `opus`, or a full model name.
- `claudeCommit.claudePath`: the `claude` executable. By default it uses the one bundled with
  the Claude Code extension, then `claude` on `PATH`.
- The **Claude Commit Message** output channel logs each call.

The commit message box only accepts buttons from extensions that VS Code lets use the
`contribSourceControlInputBoxMenu` proposal. The cce-patch installer adds this extension to
`"enable-proposed-api"` in `argv.json`, which applies after a full restart of the editor.
