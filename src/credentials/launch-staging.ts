import type { ExecRunner } from "../exec/exec-runner";

/**
 * Shared credential-staging primitives used by BOTH the managed agent-session
 * launcher (SessionManager) and the personal terminal (TerminalService), so
 * every qoder process — session or terminal — receives the user's own key
 * through the exact same fail-closed path.
 *
 * The key travels ONLY through the runner's stdin; it never appears in argv,
 * process env, logs or any output stream. `pathExpr` is a TeleOps-authored
 * shell path expression (e.g. `$HOME/.teleops-credentials/teleops-term-7.key`)
 * — double-quoted at every use site so a $HOME containing spaces stays one
 * word. It is derived from numeric ids only, never from user text.
 */

export async function stageCredentialFile(
  runner: ExecRunner,
  pathExpr: string,
  key: string,
): Promise<void> {
  const r = await runner.execScript(
    `umask 077 && mkdir -p "$(dirname "${pathExpr}")" && cat > "${pathExpr}" && chmod 600 "${pathExpr}"`,
    { input: key, timeoutMs: 20_000 },
  );
  if (r.code !== 0)
    throw new Error("could not stage the credential file on the session host");
}

export async function removeCredentialFile(
  runner: ExecRunner,
  pathExpr: string,
): Promise<void> {
  try {
    await runner.execScript(`rm -f "${pathExpr}"`, { timeoutMs: 15_000 });
  } catch {
    /* best-effort cleanup */
  }
}
