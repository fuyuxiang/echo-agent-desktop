/**
 * Automation templates share project card presentation and retain their
 * own prompt, schedule and creation action.
 */
import type { AutomationTemplate } from "./template-config";
import { TemplateCard } from "../TemplateCard";

export function AutomationTemplateGrid({
  sectionTitle,
  templates,
  onSelectTemplate,
}: {
  sectionTitle?: string;
  templates: AutomationTemplate[];
  onSelectTemplate: (template: AutomationTemplate) => void;
}) {
  return (
    <div className="atm-template-section atm-template-section--compact">
      {sectionTitle ? <div className="atm-section-title">{sectionTitle}</div> : null}
      <div className="atm-template-list template-grid">
        {templates.map((template) => (
          <TemplateCard
            key={template.id}
            icon={<template.Icon size="lg" />}
            title={template.title}
            description={template.content}
            onSelect={() => onSelectTemplate(template)}
          />
        ))}
      </div>
    </div>
  );
}
