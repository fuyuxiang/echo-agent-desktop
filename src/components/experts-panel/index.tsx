import { useEffect, useState } from "react";
import { MarketPills, type MarketTab } from "./MarketHeader";
import { ExpertsTab } from "./experts/ExpertsTab";
import { SkillsTab } from "./skills/SkillsTab";
import { ConnectorsTab } from "./connectors/ConnectorsTab";

interface Props {
  /** Navigate to the home page (after summoning an expert). */
  onGoHome?: () => void;
  onToast?: (message: string) => void;
  /** Slash navigation can open a specific capability tab directly. */
  initialTab?: MarketTab;
  /** The capability page owns navigation; standalone callers retain pills. */
  hideNavigation?: boolean;
}

/** 专家·技能·连接器 — EchoAgent-style unified market page.
 *  The pill group is rendered once here and passed into each tab's topbar
 *  left slot, mirroring EchoAgent's `headerLeft` pattern. */
export function ExpertsPanel({ onGoHome, onToast, initialTab = "experts", hideNavigation = false }: Props) {
  const [tab, setTab] = useState<MarketTab>(initialTab);

  useEffect(() => setTab(initialTab), [initialTab]);

  const pills = hideNavigation ? null : <MarketPills active={tab} onChange={setTab} />;

  return (
    <div className={`um-market${hideNavigation ? " um-market--embedded" : ""}`}>
      {tab === "experts" && (
        <ExpertsTab pills={pills} onGoHome={onGoHome} onToast={onToast} />
      )}
      {tab === "skills" && <SkillsTab pills={pills} onToast={onToast} />}
      {tab === "connectors" && <ConnectorsTab pills={pills} onToast={onToast} />}
    </div>
  );
}
