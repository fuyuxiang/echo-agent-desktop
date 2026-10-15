//! Document task continuity and a last guard for all model-facing tool text.
use super::*;
use echo_agent_tools::implementations::read_file::document;
use echo_agent_tools::types::resources::SessionFolder;

#[derive(Clone, Default)]
struct DocumentGate {
    covered: usize,
    stalled: u8,
}
#[derive(Clone, Default)]
struct ContextRecoveries(u8);

impl SessionActor {
    pub(super) async fn begin_document_task(
        &self,
        objective: &str,
        blocks: &[acp::ContentBlock],
    ) -> Result<(), acp::Error> {
        let bridge = self.tool_bridge_handle();
        let objective = blocks
            .iter()
            .find_map(|block| match block {
                acp::ContentBlock::Text(t) => t.meta.as_ref()?.get("displayText")?.as_str(),
                _ => None,
            })
            .unwrap_or(objective);
        document::begin_task(&bridge.shared_resources().await, objective)
            .await
            .map_err(|e| acp::Error::internal_error().data(format!("资料任务进度保存失败：{e}")))?;
        let sources = blocks
            .iter()
            .filter_map(|b| match b {
                acp::ContentBlock::Text(t) => t.meta.as_ref(),
                _ => None,
            })
            .filter_map(|m| m.get("echoAgentAttachments").and_then(|v| v.as_array()))
            .flatten()
            .filter_map(|v| v.as_str())
            .filter(|p| {
                std::path::Path::new(p)
                    .extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| {
                        matches!(
                            e.to_ascii_lowercase().as_str(),
                            "xlsx"
                                | "docx"
                                | "pptx"
                                | "pdf"
                                | "odt"
                                | "ods"
                                | "odp"
                                | "epub"
                                | "csv"
                                | "tsv"
                                | "txt"
                                | "md"
                        )
                    })
            })
            .map(str::to_owned)
            .collect();
        document::expect_sources(&bridge.shared_resources().await, sources)
            .await
            .map_err(|e| acp::Error::internal_error().data(e))?;
        bridge.update_resource(DocumentGate::default()).await;
        bridge.update_resource(ContextRecoveries::default()).await;
        let task = document::task_snapshot(&bridge.shared_resources().await).await;
        if !task.documents.is_empty() {
            let folder = bridge.read_resource::<SessionFolder>().await;
            self.push_system_reminder(&format!("Document task restored. Source coverage and saved analysis checkpoints are at {}. Read this journal with read_file document.mode=read/search before repeating analysis. Reading coverage alone does not prove the deliverable is complete.", folder.map(|f| f.0.join("documents/task.json").display().to_string()).unwrap_or_default()));
        }
        Ok(())
    }

    pub(super) async fn claim_context_recovery(&self) -> bool {
        let bridge = self.tool_bridge_handle();
        let mut attempts = bridge
            .read_resource::<ContextRecoveries>()
            .await
            .unwrap_or_default();
        if attempts.0 >= 2 {
            return false;
        }
        attempts.0 += 1;
        bridge.update_resource(attempts).await;
        true
    }

    pub(super) async fn reset_context_recovery(&self) {
        self.tool_bridge_handle()
            .update_resource(ContextRecoveries::default())
            .await;
    }

    pub(super) async fn document_completion_feedback(&self) -> Result<Option<String>, acp::Error> {
        let bridge = self.tool_bridge_handle();
        let task = document::task_snapshot(&bridge.shared_resources().await).await;
        let Some(feedback) = task.pending_feedback() else {
            return Ok(None);
        };
        let covered = task.documents.values().map(|d| d.covered()).sum();
        let mut gate = bridge
            .read_resource::<DocumentGate>()
            .await
            .unwrap_or_default();
        gate.stalled = if covered != gate.covered {
            0
        } else {
            gate.stalled + 1
        };
        gate.covered = covered;
        bridge.update_resource(gate.clone()).await;
        if gate.stalled >= 3 {
            return Err(acp::Error::internal_error().data("资料处理尚未完成：模型连续多次未继续读取剩余内容。已保存读取进度和阶段成果，可以在当前任务中继续处理。"));
        }
        Ok(Some(feedback))
    }

    pub(super) async fn finish_document_task(&self) -> Result<(), acp::Error> {
        document::finish_task(&self.tool_bridge_handle().shared_resources().await)
            .await
            .map_err(|e| acp::Error::internal_error().data(format!("资料任务进度保存失败：{e}")))
    }

    /// Keep the full output on disk and in the UI; only the model projection
    /// is bounded. Never cut without a working retrieval path.
    pub(super) async fn bound_tool_text(
        &self,
        text: String,
        id: &str,
        cap: usize,
    ) -> Result<String, acp::Error> {
        if text.len() <= cap {
            return Ok(text);
        }
        let bridge = self.tool_bridge_handle();
        let Some(folder) = bridge.read_resource::<SessionFolder>().await else {
            return Err(acp::Error::internal_error().data(
                "工具输出超过本次处理容量，且无法保存完整内容。本轮已停止，请在当前任务重试。",
            ));
        };
        let dir = folder.0.join("tool-results");
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| acp::Error::internal_error().data(format!("保存工具结果失败：{e}")))?;
        let name = document::revision(format!("{id}\n{text}").as_bytes());
        let path = dir.join(format!("{name}.txt"));
        if !path.exists() {
            tokio::fs::write(&path, text.as_bytes())
                .await
                .map_err(|e| acp::Error::internal_error().data(format!("保存工具结果失败：{e}")))?;
        }
        let prefix = echo_agent_sampling_types::conversation::truncate_bytes(
            &text,
            cap.saturating_sub(2048).max(256),
        );
        Ok(format!(
            "{prefix}\n\n[Bounded tool preview; full output ({} bytes) saved at {}. Use read_file with document.mode=read/search and offset/limit to retrieve additional content. Do not infer unread content. Save intermediate findings before continuing.]",
            text.len(),
            path.display()
        ))
    }

    pub(super) async fn tool_text_cap(&self) -> usize {
        let cw = self
            .chat_state_handle
            .get_sampling_config()
            .await
            .map(|c| c.context_window.get())
            .unwrap_or(128_000);
        (cw / 8).clamp(4096, 24 * 1024) as usize
    }

    /// Fit a request projection without changing durable chat history. Long
    /// historical results remain retrievable; assistant findings are retained.
    pub(super) async fn bound_request(
        &self,
        request: &mut ConversationRequest,
    ) -> Result<(), acp::Error> {
        let Some(config) = self.chat_state_handle.get_sampling_config().await else {
            return Ok(());
        };
        let window = config.context_window.get();
        let reserve = u64::from(
            request
                .max_output_tokens
                .or(config.max_completion_tokens)
                .unwrap_or(4096),
        );
        let available = window.saturating_sub(reserve).saturating_sub(window / 20);
        let latest_call = request
            .items
            .iter()
            .rposition(
                |item| matches!(item, ConversationItem::Assistant(a) if !a.tool_calls.is_empty()),
            )
            .unwrap_or(request.items.len());
        for cap in [24 * 1024, 8 * 1024, 2048] {
            if crate::sampling::estimate_request_tokens(request) <= available {
                return Ok(());
            }
            for item in request.items.iter_mut().take(latest_call) {
                if let ConversationItem::ToolResult(result) = item {
                    if result.content.len() > cap {
                        result.content = self
                            .bound_tool_text(result.content.to_string(), &result.tool_call_id, cap)
                            .await?
                            .into();
                    }
                }
            }
        }
        let estimated = crate::sampling::estimate_request_tokens(request);
        if estimated > available {
            return Err(acp::Error::internal_error().data(format!("上下文超出本次输入预算（估算 {estimated}，可用 {available}）。完整资料和已有进度已保留，请在当前任务中继续分批处理；也可减少本轮附带的历史内容。")));
        }
        Ok(())
    }
}
