import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./Button";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  message: string | null;
}

/** Last-resort renderer guard: a startup/render exception must remain visible. */
export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { message: null };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    const message = error instanceof Error ? error.message : String(error);
    return { message: message || "未知界面错误" };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("[EchoAgent] renderer startup failed", error, info.componentStack);
  }

  render() {
    if (!this.state.message) return this.props.children;

    return (
      <main
        role="alert"
        style={{
          alignItems: "center",
          background: "var(--echo-bg-primary, #f7f7f5)",
          color: "var(--echo-text-strong, #252522)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          height: "100%",
          justifyContent: "center",
          padding: 32,
          textAlign: "center",
        }}
      >
        <h1 style={{ fontSize: "var(--echo-page-title-size)", margin: 0 }}>界面启动失败</h1>
        <p style={{ color: "var(--echo-text-medium, #666660)", margin: 0, maxWidth: 560 }}>
          界面加载出现问题。请重新加载；若仍失败，请将下方错误信息提供给技术支持。
        </p>
        <code
          style={{
            background: "var(--echo-bg-tertiary, #ecece8)",
            borderRadius: 6,
            maxWidth: 720,
            overflowWrap: "anywhere",
            padding: "8px 10px",
          }}
        >
          {this.state.message}
        </code>
        <Button variant="primary" onClick={() => window.location.reload()}>
          重新加载
        </Button>
      </main>
    );
  }
}
