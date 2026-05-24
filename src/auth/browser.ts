import { spawn } from "node:child_process";
import process from "node:process";

/**
 * Spawn the OS's default URL opener for the given URL. Used to launch the user's
 * browser at the OAuth authorization endpoint during `dynmcp login`.
 *
 * The child is fully detached and its stdio is ignored so the parent process can
 * exit (or move on to wait on the callback server) without holding the browser open.
 * The returned promise resolves once the OS opener has been *spawned*, not once the
 * browser actually finishes loading — there is no portable way to know the latter.
 *
 * @throws if the OS opener cannot be spawned (e.g. PATH issues). Callers should fall
 *   back to printing the URL on stderr so the user can paste it manually.
 */
export async function openUrl(url: string): Promise<void> {
  const { command, args } = openerForPlatform(url);

  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true,
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Picks the correct OS-default URL opener for the current platform.
 *
 * - macOS uses `open <url>`
 * - Windows uses `cmd /c start "" <url>` (the empty quoted title is required to
 *   prevent `start` from interpreting the URL as the window title)
 * - everything else uses `xdg-open <url>` (Linux, BSDs)
 */
function openerForPlatform(url: string): { command: string; args: string[] } {
  switch (process.platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      return { command: "cmd", args: ["/c", "start", '""', url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}
