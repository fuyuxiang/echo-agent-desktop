import { Component, type ErrorInfo, type ReactNode } from "react";

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
          background: "#f7f7f5",
          color: "#252522",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          height: "100%",
          justifyContent: "center",
          padding: 32,
          textAlign: "center",
        }}
      >
        <h1 style={{ fontSize: 20, margin: 0 }}>界面启动失败</h1>
        <p style={{ color: "#666660", margin: 0, maxWidth: 560 }}>
          EchoAgent 遇到了界面错误，未继续显示空白页。
        </p>
        <code
          style={{
            background: "#ecece8",
            borderRadius: 6,
            maxWidth: 720,
            overflowWrap: "anywhere",
            padding: "8px 10px",
          }}
        >
          {this.state.message}
        </code>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            background: "#252522",
            border: 0,
            borderRadius: 7,
            color: "white",
            cursor: "pointer",
            padding: "8px 16px",
          }}
        >
          重新加载
        </button>
      </main>
    );
  }
}
