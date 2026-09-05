import ReactDOM from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { initializeTheme } from "./components/ThemeProvider";
import "./styles/global.css";
import "./styles/app.css";
import "./styles/automation-echo.css";
import "./styles/visual-polish.css";

initializeTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>
);
