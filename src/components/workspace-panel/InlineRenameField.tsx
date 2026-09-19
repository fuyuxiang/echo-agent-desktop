import { useEffect, useRef, useState } from "react";

export interface InlineRenameFieldProps {
  initialName: string;
  /** Caps the new name length; defaults to 240 (matches `safe_new_entry_name`). */
  maxLength?: number;
  onSubmit: (newName: string) => void | Promise<void>;
  onCancel: () => void;
}

/**
 * VSCode-style inline rename input. It replaces the node label while renaming
 * is in progress, focuses itself on mount, and reports async failures back to
 * the caller via the `onSubmit` rejection so the caller can decide whether to
 * stay in the editing state.
 */
export function InlineRenameField({
  initialName,
  maxLength = 240,
  onSubmit,
  onCancel,
}: InlineRenameFieldProps) {
  const [value, setValue] = useState(initialName);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === initialName) {
      onCancel();
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(trimmed);
      // success: parent removes us by clearing the renamingPath state
    } catch {
      // stay in editing state, let the user retry
      setSubmitting(false);
    }
  };

  const handleBlur = () => {
    if (cancelledRef.current) return;
    if (submitting) return;
    onCancel();
  };

  return (
    <input
      ref={inputRef}
      className="file-tree__rename-input"
      type="text"
      value={value}
      maxLength={maxLength}
      disabled={submitting}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          void submit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancelledRef.current = true;
          onCancel();
        }
      }}
      onBlur={handleBlur}
      data-testid="inline-rename-input"
    />
  );
}
