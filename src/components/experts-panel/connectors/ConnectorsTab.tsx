import { McpModal } from "./McpModal";

interface Props {
  pills: React.ReactNode;
  onToast?: (message: string) => void;
}

// Retained for the standalone marketplace card/detail components, which may
// still be reused by optional catalog surfaces outside this runtime list.
export type ConnectorAuthState = "none" | "installed" | "needs-auth" | "authed";

/**
 * 连接器页直接展示 EchoAgent Runtime 的用户全局 MCP 配置。
 *
 * 配置统一持久化在 `~/.echo-agent/mcp.json`，因此无需连接器市场目录、
 * 来源目录选择或额外的“查看全局连接器”跳转。
 */
export function ConnectorsTab({ pills, onToast }: Props) {
  return (
    <div className="um-page">
      <header className="um-topbar">
        <div className="um-topbar-left">{pills}</div>
      </header>
      <div className="um-scroll um-scroll--mcp">
        <McpModal embedded onClose={() => {}} onToast={onToast} />
      </div>
    </div>
  );
}
