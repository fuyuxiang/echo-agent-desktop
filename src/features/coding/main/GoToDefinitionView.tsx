/**
 * Phase 2: virtual tab that resolves a symbol's definition(s).
 *
 * Behaviour follows the standard IDE pattern:
 * - a single definition jumps to it immediately and closes the tab;
 * - multiple definitions stay open as a list so the user can pick.
 *
 * Source of truth is `coding_refs_definition`, filtered to entries whose
 * kind is `definition` server-side; the UI just renders them.
 */

import { useEffect, useMemo, useState } from "react";
import { Crosshair } from "lucide-react";

import { codingApi } from "../lib/tauri-api";
import type { ReferenceHit } from "../lib/types";

interface GoToDefinitionViewProps {
  root: string;
  symbol: string;
  /** Single-candidate shortcut: jump and close without waiting for the user. */
  onJump: (target: { path: string; line: number; name: string }) => void;
  /** Multi-candidate path: stay open and let the user pick. */
  onOpenSymbol: (symbol: { path: string; line: number; name: string }) => void;
  onClose: () => void;
}

export function GoToDefinitionView({
  root,
  symbol,
  onJump,
  onOpenSymbol,
  onClose,
}: GoToDefinitionViewProps) {
  const [candidates, setCandidates] = useState<ReferenceHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    codingApi
      .refsDefinition(root, symbol)
      .then((result) => {
        if (cancelled) return;
        setCandidates(result);
        if (result.length === 1) {
          const only = result[0];
          onJump({
            path: only.reference.file,
            line: only.reference.line,
            name: only.reference.symbol,
          });
          onClose();
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(formatError(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [root, symbol, onJump, onClose]);

  const sorted = useMemo(
    () =>
      [...candidates].sort((a, b) => {
        if (a.reference.file.length !== b.reference.file.length) {
          return a.reference.file.length - b.reference.file.length;
        }
        if (a.reference.file !== b.reference.file) {
          return a.reference.file.localeCompare(b.reference.file);
        }
        return a.reference.line - b.reference.line;
      }),
    [candidates],
  );

  if (loading) {
    return <div className="coding-views__empty">正在查找 `{symbol}` 的定义…</div>;
  }
  if (error) {
    return <div className="coding-views__error">查找定义失败：{error}</div>;
  }
  if (sorted.length === 0) {
    return <div className="coding-views__empty">未找到 `{symbol}` 的定义</div>;
  }

  return (
    <div className="coding-goto-definition">
      <header className="coding-goto-definition__header">
        <Crosshair size={16} />
        <strong>{symbol}</strong>
        <span>{sorted.length} 个候选定义</span>
      </header>
      <div className="coding-goto-definition__hint">多候选时按行号选择；单一候选会自动跳转。</div>
      {sorted.map((hit, index) => (
        <button
          key={`${hit.reference.file}:${hit.reference.line}:${index}`}
          type="button"
          className="coding-goto-definition__row"
          onClick={() => {
            onOpenSymbol({
              path: hit.reference.file,
              line: hit.reference.line,
              name: hit.reference.symbol,
            });
            onClose();
          }}
        >
          <span>{hit.reference.file}</span>
          <small>L{hit.reference.line}</small>
          <code>{hit.reference.preview}</code>
        </button>
      ))}
    </div>
  );
}

function formatError(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  return JSON.stringify(reason);
}
