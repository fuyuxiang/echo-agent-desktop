import { useEffect, useState } from "react";
import { AlertTriangle, GitBranch, Info, LoaderCircle } from "lucide-react";

import { codingAnalyzeWorkspace, type CodingWorkspaceAnalysis } from "@/lib/agent-client";

interface ProjectProfileTabProps {
  root: string;
  onOpenFile: (path: string) => void;
}

/**
 * What the workbench knows about the repository: languages, modules, rule files
 * and the verification commands it detected.
 *
 * Module detection is manifest-based, not derived from source imports, so the
 * limitation is stated here rather than presenting the list as a dependency
 * graph it is not.
 */
export function ProjectProfileTab({ root, onOpenFile }: ProjectProfileTabProps) {
  const [analysis, setAnalysis] = useState<CodingWorkspaceAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    setLoading(true);
    void codingAnalyzeWorkspace(root)
      .then((next) => {
        if (!cancelled) {
          setAnalysis(next);
          setError(null);
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause).replace(/^Error:\s*/, ""));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  if (loading && !analysis) {
    return (
      <div className="coding-doc__empty">
        <LoaderCircle size={15} className="is-spinning" />
        正在建立工程索引…
      </div>
    );
  }
  if (error) {
    return (
      <div className="coding-doc__empty is-error">
        <AlertTriangle size={15} />
        {error}
      </div>
    );
  }
  if (!analysis) return <div className="coding-doc__empty">暂无工程数据。</div>;

  return (
    <div className="coding-doc">
      <header>
        <div>
          <h1>{analysis.name}</h1>
          <p>{analysis.projectType || "通用工程"}</p>
        </div>
      </header>

      <div className="coding-doc__stats">
        <span>
          代码文件 <b>{analysis.fileCount.toLocaleString()}</b>
        </span>
        <span>
          识别模块 <b>{analysis.modules.length}</b>
        </span>
        <span>
          工程规则 <b>{analysis.instructionFiles.length}</b>
        </span>
        {analysis.hasGit && (
          <span>
            <GitBranch size={11} /> {analysis.gitBranch || "detached HEAD"} ·{" "}
            <b>{analysis.gitChangedFiles}</b> 个未提交
          </span>
        )}
      </div>

      {analysis.truncated && (
        <div className="coding-doc__note">
          <Info size={12} />
          工程规模超过扫描上限，以下为部分结果。
        </div>
      )}

      <section>
        <h2>语言构成</h2>
        <div className="coding-profile__languages">
          {analysis.languages.slice(0, 12).map((entry) => (
            <span key={entry.language}>
              {entry.language} <b>{entry.files}</b>
            </span>
          ))}
        </div>
      </section>

      <section>
        <h2>
          模块 <small>基于构建清单识别</small>
        </h2>
        <div className="coding-doc__note">
          <Info size={12} />
          模块依据构建清单所在目录推断，并非源码级依赖分析；调用图与影响范围分析将在后续版本接入。
        </div>
        <div className="coding-profile__modules">
          {analysis.modules.map((module) => (
            <div key={module.path}>
              <strong>{module.name}</strong>
              <em>{module.kind}</em>
              <code>{module.path}</code>
              {module.dependencies.length > 0 && <small>依赖 {module.dependencies.join("、")}</small>}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>验证命令</h2>
        {analysis.validationCommands.length === 0 ? (
          <p className="coding-doc__muted">未从工程清单识别到验证命令。</p>
        ) : (
          <ul className="coding-profile__commands">
            {analysis.validationCommands.map((command) => (
              <li key={command}>
                <code>{command}</code>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>工程规则</h2>
        {analysis.instructionFiles.length === 0 ? (
          <p className="coding-doc__muted">未发现 AGENTS.md 等规则文件。</p>
        ) : (
          <div className="coding-profile__rules">
            {analysis.instructionFiles.map((path) => (
              <button key={path} type="button" onClick={() => onOpenFile(path)}>
                {path}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
