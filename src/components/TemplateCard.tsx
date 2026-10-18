import type { ReactNode } from "react";

/** Shared template choice: consistent presentation, feature-owned creation. */
export function TemplateCard({ icon, title, description, onSelect }: {
  icon: ReactNode;
  title: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <button type="button" className="project-card2 template-card" onClick={onSelect}>
      <span className="project-card2__glyph" aria-hidden="true">{icon}</span>
      <span className="project-card2__body">
        <span className="project-card2__name" title={title}>{title}</span>
        <span className="project-card2__desc" title={description}>{description}</span>
      </span>
    </button>
  );
}
