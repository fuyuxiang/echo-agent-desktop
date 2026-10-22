use serde::{Deserialize, Serialize};

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn id() -> String {
    uuid::Uuid::now_v7().to_string()
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub id: String,
    pub name: String,
    pub expert: Option<String>,
    pub role: String,
    pub profile: serde_json::Value,
    pub model_id: String,
    pub session_id: Option<String>,
    pub discussion_session_id: Option<String>,
    pub seen_seq: u64,
    #[serde(default)]
    pub discussion_seen_seq: u64,
    pub generation: u64,
    /// Explicit memory reset also fences historical recall and re-extraction.
    #[serde(default)]
    pub history_start_seq: u64,
    #[serde(default)]
    pub removed: bool,
}

impl Member {
    pub fn reset_context(&mut self, isolate_memory: bool) {
        self.session_id = None;
        self.discussion_session_id = None;
        self.seen_seq = self.history_start_seq;
        self.discussion_seen_seq = self.history_start_seq;
        if isolate_memory {
            self.generation += 1;
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub seq: u64,
    pub member_id: Option<String>,
    pub kind: String,
    pub text: String,
    pub created_at: u64,
    pub work_id: Option<String>,
    pub reply_to: Option<String>,
    pub attachments: Vec<String>,
    pub tool_calls: Vec<serde_json::Value>,
    #[serde(default)]
    pub knowledge: Knowledge,
    /// Follow-ups share the original request instead of spawning another team.
    #[serde(default)]
    pub request_id: Option<String>,
    /// Explicit recipients of a supplement; empty only for legacy records.
    #[serde(default)]
    pub member_ids: Vec<String>,
    #[serde(default)]
    pub stop_root_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Knowledge {
    #[serde(default)]
    pub personal: bool,
    #[serde(default)]
    pub organization: bool,
    #[serde(default)]
    pub organization_scope_ids: Vec<String>,
    #[serde(default)]
    pub context: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Work {
    pub id: String,
    pub root_id: String,
    pub parent_id: Option<String>,
    pub continuation_of: Option<String>,
    pub member_id: String,
    pub prompt: String,
    pub status: String,
    pub discussion: bool,
    pub epoch: u64,
    pub depth: u32,
    pub created_at: u64,
    pub session_id: Option<String>,
    pub prompt_id: String,
    pub output: String,
    pub error: Option<String>,
    pub tokens: u64,
    pub summary: bool,
    #[serde(default)]
    pub seen_events: Vec<String>,
    #[serde(default)]
    pub output_filter: echo_agent_memory::text_utils::PublicText,
    #[serde(default)]
    pub context_seq: u64,
    #[serde(default)]
    pub consumed_followups: Vec<String>,
    /// Terminal child results already included when preparing this prompt.
    #[serde(default)]
    pub context_children: Vec<String>,
}

impl Work {
    pub fn active(&self) -> bool {
        matches!(self.status.as_str(), "dispatching" | "running" | "stopping")
    }
    pub fn terminal(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "failed" | "cancelled")
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub id: String,
    pub text: String,
    pub message_id: Option<String>,
    pub created_at: u64,
    #[serde(default)]
    pub confirmed: bool,
    #[serde(default)]
    pub voided: bool,
    #[serde(default)]
    pub history: Vec<DecisionVersion>,
    #[serde(default)]
    pub updated_at: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionVersion {
    #[serde(default)]
    pub action: String,
    pub text: String,
    pub changed_at: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub goal: String,
    pub cwd: String,
    pub source_session_id: Option<String>,
    pub source_team_id: Option<String>,
    pub coordinator_id: String,
    pub permission_mode: String,
    pub members: Vec<Member>,
    pub messages: Vec<Message>,
    pub works: Vec<Work>,
    pub decisions: Vec<Decision>,
    pub archived: bool,
    pub pinned: bool,
    pub paused: bool,
    pub epoch: u64,
    pub revision: u64,
    pub created_at: u64,
    pub updated_at: u64,
    pub max_calls: usize,
    pub token_budget: u64,
}

impl Group {
    pub fn post(
        &mut self,
        member: Option<String>,
        kind: &str,
        text: String,
        work: Option<String>,
    ) -> &mut Message {
        let seq = self.messages.last().map_or(1, |m| m.seq + 1);
        self.messages.push(Message {
            id: id(),
            seq,
            member_id: member,
            kind: kind.into(),
            text,
            created_at: now(),
            work_id: work,
            reply_to: None,
            attachments: vec![],
            tool_calls: vec![],
            knowledge: Knowledge::default(),
            request_id: None,
            member_ids: vec![],
            stop_root_id: None,
        });
        self.messages.last_mut().unwrap()
    }
    pub fn message_request(&self, message: &Message) -> Option<String> {
        message
            .request_id
            .clone()
            .or_else(|| {
                message
                    .work_id
                    .as_ref()
                    .and_then(|id| self.works.iter().find(|w| &w.id == id))
                    .map(|w| w.root_id.clone())
            })
            .or_else(|| {
                self.works
                    .iter()
                    .any(|w| w.root_id == message.id)
                    .then(|| message.id.clone())
            })
    }
    pub fn message_prompt(&self, message: &Message) -> String {
        match message
            .reply_to
            .as_ref()
            .and_then(|id| self.messages.iter().find(|m| &m.id == id))
        {
            Some(quoted) => format!(
                "回复引用 [id={}]：\n{}\n\n{}",
                quoted.id, quoted.text, message.text
            ),
            None => message.text.clone(),
        }
    }
    fn request_stopped(&self, root: &str) -> bool {
        self.messages
            .iter()
            .any(|m| m.stop_root_id.as_deref() == Some(root))
    }
    pub fn request_owner(&self, root: &str) -> String {
        let mut initial = self.works.iter().filter(|w| {
            w.root_id == root && w.parent_id.is_none() && w.continuation_of.is_none() && !w.summary
        });
        match (initial.next(), initial.next()) {
            (Some(owner), None) => owner.member_id.clone(),
            _ => self.coordinator_id.clone(),
        }
    }
    pub fn followup_applies(&self, message: &Message, work: &Work) -> bool {
        if message.request_id.as_deref() != Some(&work.root_id) {
            return false;
        }
        let owner = self.request_owner(&work.root_id);
        message.member_ids.is_empty()
            || message.member_ids.contains(&work.member_id)
            || message.member_ids.contains(&owner)
            || work.member_id == owner
    }
    pub fn request_attachments(&self, root: &str) -> Vec<String> {
        let mut paths = vec![];
        for path in self
            .messages
            .iter()
            .filter(|m| m.id == root || m.request_id.as_deref() == Some(root))
            .flat_map(|m| &m.attachments)
        {
            if !paths.contains(path) {
                paths.push(path.clone());
            }
        }
        paths
    }
    pub fn followup_context(&self, root: &str) -> Result<String, String> {
        let mut context = String::new();
        for m in self
            .messages
            .iter()
            .filter(|m| m.request_id.as_deref() == Some(root))
        {
            context.push_str(&format!(
                "用户补充 [id={}; 收件人={}]：{}\n{}\n\n",
                m.id,
                m.member_ids
                    .iter()
                    .filter_map(|id| self.members.iter().find(|member| &member.id == id))
                    .map(|m| m.name.as_str())
                    .collect::<Vec<_>>()
                    .join("、"),
                self.message_prompt(m),
                m.knowledge.context
            ));
            if context.chars().count() > 50_000 {
                return Err("本次任务的补充超过上下文容量，请围绕最新目标继续；消息已保留".into());
            }
        }
        Ok(context)
    }
    pub fn retry_work(&mut self, work_id: &str) -> Result<Vec<(String, String)>, String> {
        let work = self
            .works
            .iter()
            .find(|w| w.id == work_id)
            .cloned()
            .ok_or("工作不存在")?;
        if !matches!(work.status.as_str(), "failed" | "uncertain" | "cancelled") {
            return Err("只能重试失败、停止或执行情况未确认的工作".into());
        }
        let sessions = if work.status == "uncertain" {
            self.stop_work(Some(work_id))?
        } else {
            vec![]
        };
        self.paused = false;
        let root = id();
        let source = self.messages.iter().find(|m| m.id == work.root_id).cloned();
        let supplements = self.followup_context(&work.root_id)?;
        let attachments = self.request_attachments(&work.root_id);
        self.enqueue(&root, &work.member_id, format!("此前工作未完成。请先检查已有文件和执行结果，避免重复产生副作用，再完成：\n{}\n用户最新补充与纠正：\n{supplements}",work.prompt),work.discussion,None,0)?;
        let message = self.post(None, "user", format!("检查后继续：{}", work.prompt), None);
        message.id = root;
        message.attachments = attachments;
        if let Some(source) = source {
            message.knowledge = source.knowledge;
        }
        Ok(sessions)
    }
    pub fn enqueue(
        &mut self,
        root: &str,
        member: &str,
        prompt: String,
        discussion: bool,
        parent: Option<String>,
        depth: u32,
    ) -> Result<String, String> {
        if self.archived || self.paused {
            return Err("专家团已暂停或归档，请先恢复协作".into());
        }
        if !self.members.iter().any(|m| m.id == member && !m.removed) {
            return Err("指定成员不在本专家团中".into());
        }
        let calls = self.works.iter().filter(|w| w.root_id == root).count();
        if calls >= self.max_calls || depth > 3 {
            return Err("本次协作已达到自动调用上限，请查看结果后继续提问".into());
        }
        if self
            .works
            .iter()
            .filter(|w| w.root_id == root && w.member_id == member)
            .count()
            >= 3
        {
            return Err("该成员已多次参与本次协作，请汇总已有结果".into());
        }
        if self
            .works
            .iter()
            .filter(|w| w.root_id == root)
            .map(|w| w.tokens)
            .sum::<u64>()
            >= self.token_budget
        {
            return Err("本次协作已达到 Token 预算，请调整专家团设置后继续".into());
        }
        let key = id();
        self.works.push(Work {
            id: key.clone(),
            root_id: root.into(),
            parent_id: parent,
            continuation_of: None,
            member_id: member.into(),
            prompt,
            status: "queued".into(),
            discussion,
            epoch: self.epoch,
            depth,
            created_at: now(),
            session_id: None,
            prompt_id: id(),
            output: String::new(),
            error: None,
            tokens: 0,
            summary: false,
            seen_events: vec![],
            output_filter: Default::default(),
            context_seq: 0,
            consumed_followups: vec![],
            context_children: vec![],
        });
        Ok(key)
    }
    pub fn ready_callbacks(&mut self) {
        if self.paused || self.archived {
            return;
        }
        let parents = self
            .works
            .iter()
            .filter(|w| {
                w.status == "waiting_children"
                    && w.epoch == self.epoch
                    && !self.request_stopped(&w.root_id)
            })
            .cloned()
            .collect::<Vec<_>>();
        for parent in parents {
            let children = self
                .works
                .iter()
                .filter(|w| w.parent_id.as_deref() == Some(&parent.id))
                .collect::<Vec<_>>();
            if children.is_empty()
                || children.iter().any(|w| !w.terminal())
                || self
                    .works
                    .iter()
                    .any(|w| w.continuation_of.as_deref() == Some(&parent.id))
            {
                continue;
            }
            let results = children
                .iter()
                .map(|w| {
                    format!(
                        "{} [{}]: {}{}",
                        self.members
                            .iter()
                            .find(|m| m.id == w.member_id)
                            .map(|m| m.name.as_str())
                            .unwrap_or("成员"),
                        w.status,
                        w.output,
                        w.error.as_deref().unwrap_or("")
                    )
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            let previous_error = parent.error.as_deref().unwrap_or("无");
            match self.enqueue(&parent.root_id, &parent.member_id, format!("你派发的工作已结束。请结合原始目标检查结果，向请求方汇总实际交付、验证情况及未完成事项。不要重复派发已完成工作。\n原始请求：{}\n此前回合异常：{previous_error}\n\n{results}", parent.prompt), parent.discussion, None, parent.depth) {
                Ok(next) => self.works.iter_mut().find(|w| w.id == next).unwrap().continuation_of = Some(parent.id),
                Err(error) => { let w = self.works.iter_mut().find(|w| w.id == parent.id).unwrap(); w.status = "failed".into(); w.error = Some(error); self.propagate_completion(&parent.id); }
            }
        }
    }
    pub fn finish(&mut self, work_id: &str, error: Option<String>, cancelled: bool) {
        let Some(index) = self.works.iter().position(|w| w.id == work_id) else {
            return;
        };
        if self.works[index].terminal() {
            return;
        }
        let tail = self.works[index].output_filter.finish();
        self.works[index].output.push_str(&tail);
        if !tail.is_empty() {
            if let Some(message) = self
                .messages
                .iter_mut()
                .rev()
                .find(|m| m.work_id.as_deref() == Some(work_id) && m.kind == "assistant")
            {
                message.text.push_str(&tail);
            }
        }
        let old_epoch = self.works[index].epoch != self.epoch;
        let has_children = self
            .works
            .iter()
            .any(|w| w.parent_id.as_deref() == Some(work_id) && !w.terminal());
        let has_any_children = self.works.iter().any(|w| {
            w.parent_id.as_deref() == Some(work_id)
                && !self.works[index].context_children.contains(&w.id)
        });
        let w = &mut self.works[index];
        w.error = error;
        w.status = if cancelled || old_epoch || w.status == "stopping" {
            "cancelled"
        } else if has_children || has_any_children {
            "waiting_children"
        } else if w.error.is_some() {
            "failed"
        } else {
            "completed"
        }
        .into();
        // A supplement can race the model's final token. Always give the
        // request owner a durable continuation if it has not seen that message.
        let w = self.works[index].clone();
        if w.status == "completed"
            && w.epoch == self.epoch
            && self.messages.iter().any(|m| {
                self.followup_applies(m, &w)
                    && m.seq > w.context_seq
                    && !w.consumed_followups.contains(&m.id)
            })
        {
            match self.enqueue(&w.root_id, &w.member_id, format!("请按用户对本次任务的最新补充与纠正检查并完成交付，避免重复执行已完成操作。\n原始请求：{}\n已有结果：{}", w.prompt, w.output), w.discussion, None, w.depth) {
                Ok(next) => {
                    self.works[index].status = "waiting_children".into();
                    let next = self.works.iter_mut().find(|w| w.id == next).unwrap();
                    next.continuation_of = Some(w.id);
                    next.summary = w.summary;
                }
                Err(error) => { self.works[index].status = "failed".into(); self.works[index].error = Some(error); }
            }
        }
        self.propagate_completion(work_id);
        self.ready_callbacks();
        self.ready_summaries();
    }

    /// A late session load must not replace a context changed after Stop.
    pub fn bind_session(&mut self, work_id: &str, session: &str) -> bool {
        let Some(work) = self.works.iter_mut().find(|w| w.id == work_id) else {
            return false;
        };
        if work.status != "dispatching" || work.epoch != self.epoch {
            return false;
        }
        let Some(member) = self
            .members
            .iter_mut()
            .find(|m| m.id == work.member_id && !m.removed)
        else {
            return false;
        };
        if work.discussion {
            member.discussion_session_id = Some(session.into());
        } else {
            member.session_id = Some(session.into());
        }
        work.session_id = Some(session.into());
        true
    }

    /// Called only at the serialized native-dispatch boundary. Preparing a
    /// session/knowledge bridge never means a model turn has already started.
    pub fn begin_prompt(&mut self, work_id: &str) -> bool {
        let Some(work) = self.works.iter_mut().find(|w| w.id == work_id) else {
            return false;
        };
        if work.status != "dispatching" || work.epoch != self.epoch || self.archived {
            return false;
        }
        if self.paused {
            work.status = "queued".into();
            return false;
        }
        work.status = "running".into();
        true
    }

    pub fn stop_work(&mut self, target: Option<&str>) -> Result<Vec<(String, String)>, String> {
        if target.is_some_and(|id| !self.works.iter().any(|w| w.id == id)) {
            return Err("工作不存在".into());
        }
        if target.is_none() {
            self.epoch += 1;
            self.paused = true;
        }
        let mut ids = target
            .into_iter()
            .map(str::to_string)
            .collect::<std::collections::HashSet<_>>();
        loop {
            let before = ids.len();
            for work in &self.works {
                if work.parent_id.as_ref().is_some_and(|id| ids.contains(id))
                    || work
                        .continuation_of
                        .as_ref()
                        .is_some_and(|id| ids.contains(id))
                {
                    ids.insert(work.id.clone());
                }
            }
            if ids.len() == before {
                break;
            }
        }
        if target.is_none() {
            ids.extend(self.works.iter().map(|w| w.id.clone()));
        }
        Ok(self.settle_stop(ids))
    }
    pub fn stop_request(&mut self, root: &str) -> Vec<(String, String)> {
        let ids = self
            .works
            .iter()
            .filter(|w| w.root_id == root)
            .map(|w| w.id.clone())
            .collect();
        // No callbacks may be created between settling the root and recording
        // its stop receipt in the same database transaction.
        let paused = self.paused;
        self.paused = true;
        let sessions = self.settle_stop(ids);
        self.paused = paused;
        sessions
    }
    fn settle_stop(&mut self, ids: std::collections::HashSet<String>) -> Vec<(String, String)> {
        let mut sessions = vec![];
        let mut settled = vec![];
        for work in &mut self.works {
            if work.terminal() || !ids.contains(&work.id) {
                continue;
            }
            if matches!(work.status.as_str(), "running" | "stopping") && work.session_id.is_some() {
                work.status = "stopping".into();
                sessions.push((work.session_id.clone().unwrap(), work.prompt_id.clone()));
            } else {
                work.status = "cancelled".into();
                settled.push(work.id.clone());
            }
        }
        // Settle every selected node before considering callbacks. In
        // particular, cancelling a queued continuation must settle its parent.
        for id in settled {
            self.propagate_completion(&id);
        }
        self.ready_callbacks();
        self.ready_summaries();
        sessions
    }

    pub fn repair_dependencies(&mut self) {
        let terminal = self
            .works
            .iter()
            .filter(|w| w.terminal() && w.continuation_of.is_some())
            .map(|w| w.id.clone())
            .collect::<Vec<_>>();
        for id in terminal {
            self.propagate_completion(&id);
        }
        let failed_requesters = self
            .works
            .iter()
            .filter(|w| {
                w.status == "failed"
                    && w.epoch == self.epoch
                    && self
                        .works
                        .iter()
                        .any(|child| child.parent_id.as_deref() == Some(&w.id))
                    && !self
                        .works
                        .iter()
                        .any(|next| next.continuation_of.as_deref() == Some(&w.id))
            })
            .map(|w| w.id.clone())
            .collect::<Vec<_>>();
        for id in failed_requesters {
            self.works.iter_mut().find(|w| w.id == id).unwrap().status = "waiting_children".into();
        }
    }

    fn propagate_completion(&mut self, work_id: &str) {
        let Some(w) = self.works.iter().find(|w| w.id == work_id && w.terminal()) else {
            return;
        };
        let mut original = w.continuation_of.clone();
        let output = w.output.clone();
        let status = w.status.clone();
        let error = w.error.clone();
        // A resumed coordinator can request one more check. Completing that
        // nested continuation must settle the entire original request.
        let mut visited = std::collections::HashSet::new();
        while let Some(parent_id) = original {
            if !visited.insert(parent_id.clone()) {
                break;
            }
            let Some(parent) = self.works.iter_mut().find(|w| w.id == parent_id) else {
                break;
            };
            parent.status = status.clone();
            parent.output = output.clone();
            parent.error = error.clone();
            original = parent.continuation_of.clone();
        }
    }

    pub fn enforce_budget(&mut self) {
        let exhausted = self
            .works
            .iter()
            .map(|w| w.root_id.clone())
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .filter(|root| {
                self.works
                    .iter()
                    .filter(|w| &w.root_id == root)
                    .map(|w| w.tokens)
                    .sum::<u64>()
                    >= self.token_budget
            })
            .collect::<std::collections::HashSet<_>>();
        loop {
            let pending = self
                .works
                .iter()
                .filter(|w| w.status == "queued" && exhausted.contains(&w.root_id))
                .map(|w| w.id.clone())
                .collect::<Vec<_>>();
            if pending.is_empty() {
                break;
            }
            for id in pending {
                self.finish(
                    &id,
                    Some("本次请求已达到 Token 预算，已停止后续自动派发".into()),
                    false,
                );
            }
        }
    }

    pub fn ready_summaries(&mut self) {
        if self.paused || self.archived {
            return;
        }
        let roots = self
            .works
            .iter()
            .filter(|w| w.parent_id.is_none() && w.continuation_of.is_none() && !w.summary)
            .map(|w| w.root_id.clone())
            .collect::<std::collections::HashSet<_>>();
        for root in roots {
            if self.request_stopped(&root) {
                continue;
            }
            let initial = self
                .works
                .iter()
                .filter(|w| {
                    w.root_id == root
                        && w.parent_id.is_none()
                        && w.continuation_of.is_none()
                        && !w.summary
                })
                .collect::<Vec<_>>();
            if initial.len() < 2
                || initial
                    .iter()
                    .any(|w| !w.terminal() || w.epoch != self.epoch)
                || self.works.iter().any(|w| w.root_id == root && w.summary)
            {
                continue;
            }
            let discussion = initial.iter().all(|w| w.discussion);
            let results = initial
                .iter()
                .map(|w| {
                    format!(
                        "{} [{}]：{} {}",
                        self.members
                            .iter()
                            .find(|m| m.id == w.member_id)
                            .map(|m| m.name.as_str())
                            .unwrap_or("成员"),
                        w.status,
                        w.output.chars().take(12000).collect::<String>(),
                        w.error.as_deref().unwrap_or("")
                    )
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            let prompt = format!("请归纳本轮各成员的观点与结果，回应用户原始目标，说明一致结论、分歧和未完成事项。不再派发新工作。\n\n{results}");
            match self.enqueue(
                &root,
                &self.coordinator_id.clone(),
                prompt.clone(),
                discussion,
                None,
                0,
            ) {
                Ok(id) => self.works.iter_mut().find(|w| w.id == id).unwrap().summary = true,
                Err(error) => {
                    // Record a failed delivery without spending another model
                    // call. A user retry then summarizes the actual results.
                    let mut failed = self
                        .works
                        .iter()
                        .find(|w| w.root_id == root)
                        .unwrap()
                        .clone();
                    failed.id = id();
                    failed.member_id = self.coordinator_id.clone();
                    failed.parent_id = None;
                    failed.continuation_of = None;
                    failed.prompt = prompt;
                    failed.prompt_id = id();
                    failed.status = "failed".into();
                    failed.summary = true;
                    failed.session_id = None;
                    failed.output.clear();
                    failed.tokens = 0;
                    failed.seen_events.clear();
                    failed.output_filter = Default::default();
                    failed.consumed_followups.clear();
                    failed.context_children.clear();
                    failed.created_at = now();
                    failed.error = Some(format!("成员结果已保留，但自动汇总未能启动：{error}"));
                    self.works.push(failed);
                }
            }
        }
    }
}
