/**
 * Instance path -> file path, by Script Sync's naming convention.
 *
 * Split out from syncMap.ts and deliberately free of any `vscode` import: this is the
 * half that can be wrong in interesting ways, so it has to be testable without an
 * Extension Host. syncMap.ts wraps it in the workspace search.
 *
 * Studio's Script Sync (Explorer, right-click, "Sync to…") writes real files to disk and
 * keeps them two-way with the place, naming them like this:
 *
 *     Combat.luau              ModuleScript
 *     Main.server.luau         Script
 *     Hud.client.luau          Script with RunContext = Client
 *     Legacy.local.luau        LocalScript
 *     Modules/                 Folder
 *     Combat/init.luau         a script that has children
 *
 * No plugin API reports which instances are synced or where they landed, so matching
 * works the way a person would: find files that could be this script, then score them by
 * how much of the instance's ancestry their directory path reproduces.
 */

/**
 * Maps an instance in the live tree onto the file Roblox's Script Sync wrote for it.
 *
 * Studio's Script Sync (Explorer ▸ right-click ▸ "Sync to…") writes real files to disk
 * and keeps them two-way with the place. It names them by convention:
 *
 *     Combat.luau              ModuleScript
 *     Main.server.luau         Script
 *     Hud.client.luau          Script with RunContext = Client
 *     Legacy.local.luau        LocalScript
 *     Modules/                 Folder
 *     Combat/init.luau         a script that has children
 *
 * There is no plugin API that reports which instances are synced or where they landed,
 * so this works the way a person would: look for files that could be this script, then
 * score them by how much of the instance's ancestry their directory path reproduces.
 * `game.ReplicatedStorage.Modules.Combat` matching `…/src/Modules/Combat.luau` scores 1
 * (Modules), which is enough to be confident when nothing else scores higher.
 *
 * The scoring half is pure and lives at the top of this file so it can be tested
 * without an Extension Host.
 */


/** A filename Script Sync (or Rojo) might have used, best convention first. */
export interface NameCandidate {
  /** File name, or `<ScriptName>/init…` for a script that has children. */
  fileName: string;
  /** True when the script's own name is a directory and the file inside is `init.*`. */
  isInit: boolean;
  /** Lower is a better conventional match; breaks ties between equal path scores. */
  rank: number;
}

const LUAU_EXTENSIONS = ['luau', 'lua'];

/**
 * Suffixes per class, most canonical first. `.lua` variants are included because Rojo
 * projects use the same layout with the older extension, and someone running both
 * should not get a worse experience than someone running one.
 */
function suffixesFor(className: string): string[] {
  switch (className) {
    case 'ModuleScript':
      return [''];
    case 'LocalScript':
      // Script Sync writes `.local` for the legacy class, but plenty of existing Rojo
      // trees use `.client` for it, so accept both.
      return ['.local', '.client'];
    case 'Script':
      // A Script with RunContext = Client syncs as `.client`; the plugin does not tell
      // us the RunContext, so try server first and accept client as a fallback.
      return ['.server', '.client'];
    default:
      return [''];
  }
}

/** Every filename this node could plausibly have on disk, best first. */
export function candidatesFor(name: string, className: string, hasChildren: boolean): NameCandidate[] {
  const out: NameCandidate[] = [];
  let rank = 0;

  for (const suffix of suffixesFor(className)) {
    for (const extension of LUAU_EXTENSIONS) {
      out.push({ fileName: `${name}${suffix}.${extension}`, isInit: false, rank: rank++ });
    }
  }

  // A script with children becomes a directory holding an init file. Only worth looking
  // for when the node actually has children.
  if (hasChildren) {
    for (const suffix of suffixesFor(className)) {
      for (const extension of LUAU_EXTENSIONS) {
        out.push({ fileName: `${name}/init${suffix}.${extension}`, isInit: true, rank: rank++ });
      }
    }
  }

  return out;
}

function segmentsOf(filePath: string): string[] {
  return filePath.split(/[\\/]/).filter((segment) => segment.length > 0);
}

function sameSegment(a: string, b: string): boolean {
  // Windows and macOS default to case-insensitive filesystems, and Script Sync takes
  // the instance's name verbatim, so a case difference is not evidence of a mismatch.
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * How many of the script's ancestors this file's directory path reproduces, counting
 * back from the file. Returns -1 when the file cannot be this script at all.
 *
 * `ancestors` is the instance path without `game` and without the script's own name:
 * `game.ReplicatedStorage.Modules.Combat` gives `['ReplicatedStorage', 'Modules']`.
 */
export function scoreCandidate(
  ancestors: string[],
  filePath: string,
  scriptName: string,
  isInit: boolean,
): number {
  const segments = segmentsOf(filePath);
  if (segments.length === 0) {
    return -1;
  }

  // Drop the file itself; for an init file also drop the directory named for the script.
  let directories = segments.slice(0, -1);
  if (isInit) {
    const owning = directories[directories.length - 1];
    if (owning === undefined || !sameSegment(owning, scriptName)) {
      return -1;
    }
    directories = directories.slice(0, -1);
  }

  let score = 0;
  let i = directories.length - 1;
  let j = ancestors.length - 1;
  while (i >= 0 && j >= 0 && sameSegment(directories[i], ancestors[j])) {
    score += 1;
    i -= 1;
    j -= 1;
  }
  return score;
}

export interface ScoredFile {
  filePath: string;
  candidate: NameCandidate;
}

/**
 * Picks the file most likely to be this script, or undefined when the evidence is too
 * thin. Guessing wrong here means opening the wrong file and editing the wrong script,
 * so an ambiguous result deliberately resolves to nothing and the caller falls back to
 * the read-only view.
 */
export function pickBest(ancestors: string[], scriptName: string, files: ScoredFile[]): string | undefined {
  let best: { filePath: string; score: number; rank: number; depth: number } | undefined;

  for (const file of files) {
    const score = scoreCandidate(ancestors, file.filePath, scriptName, file.candidate.isInit);
    if (score < 0) {
      continue;
    }
    const depth = segmentsOf(file.filePath).length;
    if (
      !best ||
      score > best.score ||
      (score === best.score && file.candidate.rank < best.rank) ||
      (score === best.score && file.candidate.rank === best.rank && depth < best.depth)
    ) {
      best = { filePath: file.filePath, score, rank: file.candidate.rank, depth };
    }
  }

  if (!best) {
    return undefined;
  }

  // A score of 0 means nothing above the file backed up the match. Fine when it is the
  // only candidate in the workspace; a coin flip when it is not.
  if (best.score === 0) {
    const zeroScored = files.filter(
      (file) => scoreCandidate(ancestors, file.filePath, scriptName, file.candidate.isInit) === 0,
    );
    if (zeroScored.length > 1) {
      return undefined;
    }
  }

  return best.filePath;
}

/** Splits `game.ReplicatedStorage.Modules.Combat` into its ancestors, minus `game`. */
export function ancestorsOf(instancePath: string): string[] {
  const segments = instancePath.split('.');
  return segments.slice(segments[0] === 'game' ? 1 : 0, -1);
}
