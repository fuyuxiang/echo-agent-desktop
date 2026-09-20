import { useEffect, useState } from "react";

import type { AtMentionSymbol } from "@/components/AtMentionMenu";
import { buildFileIndex } from "@/features/coding/lib/file-index";
import { getSymbolIndexClient } from "@/features/coding/lib/symbol-index";
import { isTauriAvailable } from "@/lib/tauri-kb-reader";

/**
 * Load the bounded workspace candidates shared by every Composer surface.
 * Results are abandoned on cwd changes so a slow repository never leaks its
 * paths into the next workspace.
 */
export function useWorkspaceMentions(cwd?: string): {
  filePaths: string[];
  workspaceSymbols: AtMentionSymbol[];
} {
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [workspaceSymbols, setWorkspaceSymbols] = useState<AtMentionSymbol[]>([]);

  useEffect(() => {
    const root = cwd?.trim() ?? "";
    const signal = { aborted: false };
    setFilePaths([]);
    setWorkspaceSymbols([]);
    if (!root || !isTauriAvailable()) return () => { signal.aborted = true; };

    void buildFileIndex(root, {
      signal,
      onProgress: (paths) => {
        if (!signal.aborted) setFilePaths(paths);
      },
    }).then((result) => {
      if (!signal.aborted) setFilePaths(result.paths);
    }).catch(() => undefined);

    const client = getSymbolIndexClient(root);
    const updateSymbols = () => {
      if (signal.aborted) return;
      setWorkspaceSymbols(client.symbols().map((symbol) => ({
        name: symbol.name,
        file: symbol.file,
        line: symbol.line,
        column: symbol.column,
      })));
    };
    const unsubscribe = client.subscribe(updateSymbols);
    updateSymbols();

    return () => {
      signal.aborted = true;
      unsubscribe();
    };
  }, [cwd]);

  return { filePaths, workspaceSymbols };
}
