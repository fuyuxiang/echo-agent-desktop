import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";

/**
 * Model picker dropdown for the Composer. Shows the current model id on a
 * trigger button; clicking opens a small menu listing every available model.
 * Selecting one calls onModelChange.
 */
export interface ModelOption {
  id: string;
  label?: string;
  /** Optional provider kind, used to group/sort models in the dropdown. */
  providerKind?: string;
  /** Optional provider id this model belongs to. */
  providerId?: string;
}

export function ModelSelector({
  modelId,
  models,
  onModelChange,
}: {
  /** Currently selected model id (displayed on the trigger). */
  modelId?: string;
  models: ModelOption[];
  onModelChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());

  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const selected = modelId ? optionRefs.current.get(modelId) : undefined;
    if (selected) selected.focus();
    else if (!ref.current?.contains(document.activeElement) || document.activeElement === triggerRef.current) {
      optionRefs.current.get(models[0]?.id)?.focus();
    }
  }, [modelId, models, open]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    const index = models.findIndex((model) => optionRefs.current.get(model.id) === document.activeElement);
    const focusAt = (nextIndex: number) => {
      if (models.length === 0) return;
      optionRefs.current.get(models[(nextIndex + models.length) % models.length].id)?.focus();
    };
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusAt(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusAt(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusAt(models.length - 1);
    }
  };

  const current = models.find((m) => m.id === modelId);
  const hasModels = models.length > 0;
  const triggerLabel = hasModels
    ? current?.label || current?.id || "请选择模型"
    : "未配置模型";

  return (
    <div className="model-selector" ref={ref}>
      <button
        className="model-selector__trigger"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((o) => !o);
        }}
        type="button"
        disabled={!hasModels}
        title={!hasModels ? "请先在设置中配置模型" : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? "composer-model-listbox" : undefined}
        ref={triggerRef}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="model-selector__label">{triggerLabel}</span>
        <ChevronDown size={14} strokeWidth={1.75} className="model-selector__arrow" />
      </button>
      {open && (
        <ul
          className="model-selector__menu"
          id="composer-model-listbox"
          role="listbox"
          aria-label="选择模型"
          onKeyDown={handleMenuKeyDown}
        >
          {models.length === 0 && (
            <li className="model-selector__empty">未配置模型</li>
          )}
          {models.map((m) => (
            <li key={m.id} role="none">
              <button
                type="button"
                className={
                  "model-selector__item" +
                  (m.id === modelId ? " model-selector__item--active" : "")
                }
                onClick={(event) => {
                  event.stopPropagation();
                  onModelChange(m.id);
                  close();
                }}
                role="option"
                aria-selected={m.id === modelId}
                ref={(element) => {
                  if (element) optionRefs.current.set(m.id, element);
                  else optionRefs.current.delete(m.id);
                }}
              >
                <span className="model-selector__item-label">{m.label || m.id}</span>
                <span className="model-selector__item-id">{m.id}</span>
                {m.id === modelId && <Check size={14} className="model-selector__check" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
