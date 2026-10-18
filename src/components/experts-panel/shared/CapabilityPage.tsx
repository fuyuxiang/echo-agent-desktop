import { useRef, type ReactNode } from "react";
import { SearchIcon, XCloseIcon } from "@/foundation/components/Icon/icons";
import { Button, IconButton } from "@/components/Button";

interface Props {
  title: string;
  description?: string;
  className?: string;
  search?: {
    value: string;
    onChange: (value: string) => void;
    label: string;
    placeholder?: string;
  };
  actions?: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
}

/** The extension pages share one toolbar, content gutter and scroll owner. */
export function CapabilityPage({ title, description, className = "", search, actions, summary, children }: Props) {
  const searchRef = useRef<HTMLInputElement>(null);
  return (
    <section className={`capability-page ${className}`} aria-label={title}>
      <div className="capability-page__inner">
        <header className="capability-page__header">
          <div className="capability-page__heading">
            <h2 className="capability-page__title">{title}</h2>
            {description && <p className="capability-page__description">{description}</p>}
          </div>
          <div className="capability-page__controls">
            {search && (
              <div className="capability-search">
                <SearchIcon size="sm" className="capability-search__icon" />
                <input ref={searchRef} type="text" aria-label={search.label}
                  placeholder={search.placeholder ?? search.label}
                  value={search.value} onChange={(event) => search.onChange(event.target.value)} />
                {search.value && <IconButton className="capability-search__clear"
                  label={`清空${search.label}`} onClick={() => { search.onChange(""); searchRef.current?.focus(); }}>
                  <XCloseIcon size="sm" />
                </IconButton>}
              </div>
            )}
            {actions && <div className="capability-page__actions">{actions}</div>}
          </div>
        </header>
        {summary && <div className="capability-page__summary">{summary}</div>}
        <div className="capability-page__content">{children}</div>
      </div>
    </section>
  );
}

export function CapabilityEmptyState({ icon, title, description, onClear }: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  onClear?: () => void;
}) {
  return <div className="capability-empty" role="status">
    {icon && <span className="capability-empty__icon" aria-hidden="true">{icon}</span>}
    <div className="capability-empty__copy">
      <p>{title}</p>
      {description && <div className="capability-empty__description">{description}</div>}
    </div>
    {onClear && <Button onClick={onClear}>清空搜索</Button>}
  </div>;
}

export function CapabilityError({ children, onRetry, retrying = false }: {
  children: ReactNode;
  onRetry: () => void;
  retrying?: boolean;
}) {
  return <div className="capability-error" role="alert">
    <span>{children}</span>
    <Button onClick={onRetry} disabled={retrying} aria-busy={retrying}>
      {retrying ? "重试中…" : "重试"}
    </Button>
  </div>;
}
