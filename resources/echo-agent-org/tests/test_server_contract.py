from __future__ import annotations

from echo_agent_org.client import OrgClient, _parse_retrieve


def test_parse_server_camel_case_retrieve_payload():
    result = _parse_retrieve({
        "chunks": [{
            "chunkId": "c1",
            "docId": "d1",
            "docTitle": "制度",
            "text": "正文",
            "scopeKind": "team",
            "updatedAt": 123,
            "citation": {"startMs": 5000, "endMs": 7000, "openUrl": "echo://doc/d1"},
            "owner": {"displayName": "张三"},
        }],
        "memories": [{"id": "m1", "kind": "fact", "content": "结论", "scopeKind": "org"}],
    })
    chunk = result.chunks[0]
    assert (chunk.chunk_id, chunk.doc_id, chunk.doc_title) == ("c1", "d1", "制度")
    assert chunk.scope_kind == "team"
    assert chunk.citation.start_ms == 5000
    assert chunk.citation.open_url == "echo://doc/d1"
    assert chunk.owner_name == "张三"
    assert result.memories[0].scope_kind == "org"


async def test_submit_knowledge_uses_server_camel_case_contract():
    client = OrgClient({"server_url": "https://unused"})
    seen = {}

    async def fake_post(path, payload):
        seen.update({"path": path, "payload": payload})
        return {"promotionId": "p1"}

    client._post = fake_post
    promotion_id = await client.submit_knowledge(
        kind="fact", content="结论", target_scope="scope-1"
    )
    assert promotion_id == "p1"
    assert seen["path"] == "/api/v1/promotions"
    assert seen["payload"]["payloadType"] == "memory"
    assert seen["payload"]["targetScope"] == "scope-1"
