// WakaTime plugin for the Pi coding agent (pi).
//
// Calls wakatime-cli --sync-ai-activity on session start and after prompt,
// tool, and turn events. wakatime-cli parses Pi's saved session transcripts
// (~/.pi/agent/sessions) itself, so heartbeats, tokens, and prompt lengths
// come from the same code path the official agent plugins use.
import { createPiHooks } from './runtime.js';

let lastDirectory;

export default function register(pi) {
  const hooks = createPiHooks(() => lastDirectory);

  hooks.setup(pi);

  pi.on('session_start', (event, ctx) => {
    if (ctx?.cwd) lastDirectory = ctx.cwd;
    hooks.onSessionStart();
  });

  pi.on('input', (event, ctx) => {
    if (ctx?.cwd) lastDirectory = ctx.cwd;
    hooks.onActivity();
  });

  pi.on('tool_result', (event, ctx) => {
    if (hooks.isFileTool(event.toolName)) {
      if (ctx?.cwd) lastDirectory = ctx.cwd;
      hooks.onActivity();
    }
  });

  pi.on('turn_end', (event, ctx) => {
    if (ctx?.cwd) lastDirectory = ctx.cwd;
    hooks.onTurnEnd();
  });

  pi.on('agent_settled', () => hooks.onSettled());
}
