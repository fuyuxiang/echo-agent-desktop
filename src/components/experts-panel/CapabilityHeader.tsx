import {
  ExpertTabIcon, SkillTabIcon, ConnectorTabIcon,
} from "@/foundation/components/Icon/icons";

export type CapabilityTab = "experts" | "skills" | "connectors";

const TABS: { key: CapabilityTab; label: string; Icon: typeof ExpertTabIcon }[] = [
  { key: "experts", label: "专家", Icon: ExpertTabIcon },
  { key: "skills", label: "技能", Icon: SkillTabIcon },
  { key: "connectors", label: "连接器", Icon: ConnectorTabIcon },
];

/** Navigation for locally managed extension capabilities. */
export function CapabilityPills({
  active, onChange,
}: {
  active: CapabilityTab;
  onChange: (t: CapabilityTab) => void;
}) {
  return (
    <div className="um-pills" role="tablist" aria-label="扩展分类">
      {TABS.map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={active === key}
          className={`um-pill${active === key ? " um-pill--active" : ""}`}
          onClick={() => onChange(key)}
        >
          <Icon size="sm" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
