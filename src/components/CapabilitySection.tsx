import type { ReactNode } from "react";
import { CAPABILITY_NAV_ITEMS } from "@/lib/capability-navigation";
import "@/styles/panel-navigation.css";

export function CapabilitySection({ active, onNavigate, children }: {
  active: string;
  onNavigate?: (label: string) => void;
  children: ReactNode;
}) {
  return <div className="panel-section panel-section--capabilities">
    <nav className="panel-navigation panel-navigation--capabilities" aria-label="专家·技能·连接器管理">
      <strong>专家·技能·连接器</strong>
      <div className="panel-navigation__links">{CAPABILITY_NAV_ITEMS.map(({ route, title }) => (
        <button key={route} type="button" aria-current={route === active ? "page" : undefined}
          onClick={() => onNavigate?.(route)}>{title}</button>
      ))}</div>
    </nav>
    {children}
  </div>;
}
